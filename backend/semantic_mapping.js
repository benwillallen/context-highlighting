import { pipeline, env } from '@xenova/transformers';
import * as tf from '@tensorflow/tfjs';

console.log('Semantic mapping module loaded');

// Configure the environment for browser extensions
// Due to a bug in onnxruntime-web, we disable multithreading
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = '/ort/';
env.allowRemoteModels = true;
env.allowLocalModels = false;
console.log('Environment configured:', { numThreads: env.backends.onnx.wasm.numThreads, wasmPaths: env.backends.onnx.wasm.wasmPaths, allowRemoteModels: env.allowRemoteModels, allowLocalModels: env.allowLocalModels });

export class TopicExtractor {
    extractor;
    entities;
    initialized = false;

    async initialize(isChromium = false) {
        console.log('TopicExtractor: initialize called with isChromium =', isChromium);
        if (this.initialized) {
            console.log('TopicExtractor: Already initialized');
            return;
        }
        
        // Enable local models in Chromium (doesn't work in Firefox)
        if (isChromium) {
            console.log('TopicExtractor: Enabling local models for Chromium');
            env.allowLocalModels = true;
        }
        
        try {
            console.log('TopicExtractor: Loading feature extraction model');
            console.time('feature-extraction-model-load');
            this.extractor = await pipeline('feature-extraction', 'Xenova/all-mpnet-base-v2', {
                // dtype: 'q8', // For @huggingface not @xenova
                quantized: true,
                device: 'webGPU',
            });
            console.timeEnd('feature-extraction-model-load');
            console.log('TopicExtractor: Feature extraction model loaded successfully');
            
            console.log('TopicExtractor: Loading NER model');
            console.time('ner-model-load');
            this.entities = await pipeline('ner', 'Xenova/distilbert-base-multilingual-cased-ner-hrl', {
                // dtype: 'q8', // For @huggingface not @xenova
                quantized: true,
            });
            console.timeEnd('ner-model-load');
            console.log('TopicExtractor: NER model loaded successfully');
            
            this.initialized = true;
            console.log('TopicExtractor: Initialization complete');
        } catch (error) {
            console.error('TopicExtractor: Failed to initialize models:', error);
            throw error;
        }
    }

    async extractMainTopics(text, topN, options) {
        console.log(`TopicExtractor: extractMainTopics called with ${text.length} chars, topN=${topN}`, options);
        if (!this.extractor || !this.entities) {
            console.error('TopicExtractor: Models not initialized');
            throw new Error('Initialize must be called first');
        }

        console.time('extract-topics-total');

        console.log('TopicExtractor: Chunking text');
        console.time('chunking');
        const chunks = this.chunkTextWithOverlap(text, 512, 50);
        console.timeEnd('chunking');
        console.log(`TopicExtractor: Text chunked into ${chunks.length} parts`);

        console.log('TopicExtractor: Processing chunks');
        console.time('process-chunks');
        const processedChunks = await this.processChunks(chunks);
        console.timeEnd('process-chunks');
        console.log(`TopicExtractor: Processed ${processedChunks.length} chunks`);

        console.log('TopicExtractor: Aggregating entities');
        console.time('aggregate-entities');
        // aggregateEntities now returns validChunkTensors
        const { entityMap, chunkTensors: validChunkTensors } = await this.aggregateEntities(processedChunks);
        console.timeEnd('aggregate-entities');
        console.log(`TopicExtractor: Found ${entityMap.size} unique entities after aggregation`);

        console.log('TopicExtractor: Computing document embedding');
        console.time('doc-embedding');
        // Use only validChunkTensors for document embedding
        const docEmbedding = this.averageEmbeddings(validChunkTensors);
        console.timeEnd('doc-embedding');

        console.log('TopicExtractor: Scoring and sorting entities');
        console.time('scoring');
        const results = this.scoreAndSortEntities(entityMap, docEmbedding, topN, options);
        console.timeEnd('scoring');
        console.log(`TopicExtractor: Selected top ${results.length} topics`);

        console.log('TopicExtractor: Cleaning up tensors');
        // Dispose valid chunk tensors that were collected
        validChunkTensors.forEach(t => {
            if (t && !t.isDisposed) t.dispose();
        });
        // Dispose document embedding
        if (docEmbedding && !docEmbedding.isDisposed) docEmbedding.dispose();
        // Dispose final entityMap embedding sums
        entityMap.forEach(agg => {
            if (agg.embeddingSum && !agg.embeddingSum.isDisposed) {
                agg.embeddingSum.dispose();
            }
        });

        console.timeEnd('extract-topics-total');
        console.log('TopicExtractor: Topic extraction complete', results);
        return results;
    }

    async processChunks(chunks) {
        console.log(`TopicExtractor: Processing ${chunks.length} chunks selectively`);
        const results = [];
        for (let index = 0; index < chunks.length; index++) {
            const chunk = chunks[index];
            console.log(`TopicExtractor: Processing chunk ${index + 1}/${chunks.length}, length=${chunk.text.length}`);
            try {
                console.time(`chunk-${index}-processing`);

                console.time(`chunk-${index}-ner`);
                const nerResults = await this.entities(chunk.text);
                console.timeEnd(`chunk-${index}-ner`);
                console.log(`TopicExtractor: Chunk ${index + 1} - Found ${nerResults.length} entity tokens`);

                let minStart = 0;
                const tokenEntities = nerResults.map(ent => {
                    minStart = chunk.text.indexOf(ent.word, minStart);
                    return {
                        ...ent,
                        start: typeof ent.start === 'number' ? ent.start :
                            minStart,
                        end: typeof ent.end === 'number' ? ent.end :
                            minStart + ent.word.length
                    };
                });

                console.time(`chunk-${index}-merge-entities`);
                const mergedEntities = this.mergeEntityTokens(tokenEntities)
                    .map(entity => ({
                        ...entity,
                        start: chunk.offset + entity.start,
                        end: chunk.offset + entity.end
                    }));
                console.timeEnd(`chunk-${index}-merge-entities`);
                console.log(`TopicExtractor: Chunk ${index + 1} - Merged into ${mergedEntities.length} entities`);

                let embeddingTensor = null;
                if (mergedEntities.length > 0) {
                    // Only calculate embedding if entities were found
                    console.time(`chunk-${index}-embedding`);
                    const rawEmbedding = await this.extractor(chunk.text, { pooling: 'mean' });
                    embeddingTensor = this.convertTransformersTensor(rawEmbedding);
                    console.timeEnd(`chunk-${index}-embedding`);
                    console.log(`TopicExtractor: Chunk ${index + 1} - Embedding calculated.`);
                } else {
                    console.log(`TopicExtractor: Chunk ${index + 1} - Skipping embedding (no entities found).`);
                }

                console.timeEnd(`chunk-${index}-processing`);
                results.push({
                    embeddings: embeddingTensor, // Will be null if skipped
                    entities: mergedEntities
                });

            } catch (error) {
                console.error(`TopicExtractor: Error processing chunk ${index}:`, error);
                // Decide how to handle errors: skip chunk, throw, return partial results?
                // For now, let's push a result indicating failure for this chunk
                results.push({ embeddings: null, entities: [], error: error.message });
                // Optionally re-throw if one chunk failure should stop the whole process
                // throw error;
            }
        }
        return results;
    }

    convertTransformersTensor(tensor) {
        try {
            // Handle the different formats from @xenova/transformers output
            if (tensor.dims) {
                return tf.tensor(this.tensorToArray(tensor));
            } else if (tensor.data && Array.isArray(tensor.data)) {
                return tf.tensor(tensor.data);
            } else if (tensor.toFloat32Array) {
                return tf.tensor(Array.from(tensor.toFloat32Array()));
            } else {
                // Generic fallback for different tensor formats
                return tf.tensor(Array.from(tensor.data || []));
            }
        } catch (error) {
            console.error('TopicExtractor: Error converting tensor:', error);
            throw new Error(`Failed to convert tensor: ${error.message}`);
        }
    }

    tensorToArray(tensor) {
        if (tensor.dims && tensor.dims.length === 2 && tensor.dims[0] === 1) {
            return Array.from(tensor.data.slice(0, tensor.dims[1]));
        }
        return Array.from(tensor.data || []);
    }

    async aggregateEntities(chunks) {
        console.log('TopicExtractor: Aggregating entities from chunks');
        const entityMap = new Map();
        const chunkTensors = []; // Only store non-null tensors
        let firstEmbeddingShape = null; // Store the shape from the first valid embedding

        chunks.forEach((chunk, chunkIndex) => {
            // Add embedding to list only if it exists
            if (chunk.embeddings && !chunk.embeddings.isDisposed) {
                chunkTensors.push(chunk.embeddings);
                if (!firstEmbeddingShape) {
                    firstEmbeddingShape = chunk.embeddings.shape;
                }
            } else if (chunk.embeddings && chunk.embeddings.isDisposed) {
                 console.warn(`Chunk ${chunkIndex} embedding was already disposed before aggregation.`);
            }

            chunk.entities.forEach(entity => {
                const key = entity.text.toLowerCase();
                let existing = entityMap.get(key);

                // Initialize if it's the first time seeing this entity
                if (!existing) {
                    // Determine the correct shape for the zero tensor
                    // Use the shape from the current chunk if available,
                    // otherwise use the first shape we found, or fallback later
                    const initialShape = chunk.embeddings ? chunk.embeddings.shape : firstEmbeddingShape;
                    existing = {
                        indices: [],
                        types: new Set(),
                        // Initialize embeddingSum only if we know the shape
                        embeddingSum: initialShape ? tf.zeros(initialShape) : null,
                        count: 0,
                        mentions: [],
                        // Track how many embeddings contributed to the sum
                        embeddingCount: 0
                    };
                }

                // If embeddingSum is null (because no previous chunk had an embedding),
                // try to initialize it now.
                if (!existing.embeddingSum && chunk.embeddings && !chunk.embeddings.isDisposed) {
                    existing.embeddingSum = tf.zeros(chunk.embeddings.shape);
                }

                // Add the current chunk's embedding only if it exists and embeddingSum is initialized
                if (chunk.embeddings && !chunk.embeddings.isDisposed && existing.embeddingSum) {
                    const currentSum = existing.embeddingSum;
                    const newSum = tf.tidy(() => {
                        // Ensure shapes match before adding - might happen if models change unexpectedly
                        if (JSON.stringify(currentSum.shape) !== JSON.stringify(chunk.embeddings.shape)) {
                            console.warn(`Shape mismatch for entity "${key}". Expected ${JSON.stringify(currentSum.shape)}, got ${JSON.stringify(chunk.embeddings.shape)}. Skipping add.`);
                            return currentSum.clone(); // Return the old sum
                        }
                        return currentSum.add(chunk.embeddings);
                    });

                    // Dispose the old sum tensor and update
                    currentSum.dispose();
                    existing.embeddingSum = newSum;
                    existing.embeddingCount++; // Increment count only when embedding is added
                } else if (chunk.embeddings && chunk.embeddings.isDisposed) {
                     console.warn(`Skipping disposed embedding for entity "${key}" from chunk ${chunkIndex}`);
                } else if (!existing.embeddingSum) {
                     console.warn(`Cannot add embedding for entity "${key}" yet, embeddingSum not initialized.`);
                }


                existing.indices.push(entity.start);
                this.getSubcategoriesFromEntity(entity).forEach(type => existing.types.add(type));
                existing.mentions.push({
                    text: entity.text,
                    start: entity.start,
                    end: entity.end,
                    type: entity.type
                });
                existing.count++; // Increment mention count regardless of embedding
                entityMap.set(key, existing);
            });
        });
        console.log(`TopicExtractor: Found ${entityMap.size} unique entities before grouping`);

        // Handle entities where embeddingSum might still be null (if they only appeared in chunks without embeddings)
        // Option 1: Remove them? Option 2: Keep them but they won't be scored by similarity?
        // Let's keep them for now, scoreAndSortEntities will handle null embeddings.
        entityMap.forEach((agg, key) => {
            if (!agg.embeddingSum) {
                console.warn(`Entity "${key}" has no valid embeddingSum after aggregation.`);
                // Optionally create a zero tensor now if a shape is known
                if (firstEmbeddingShape) {
                    agg.embeddingSum = tf.zeros(firstEmbeddingShape);
                    agg.embeddingCount = 0; // Ensure embeddingCount is 0
                }
            }
        });


        console.log('TopicExtractor: Grouping related entities');
        console.time('group-entities');
        // Pass the potentially modified entityMap to grouping
        const { groups, ungroupedEntities } = await this.groupRelatedEntities(entityMap);
        console.timeEnd('group-entities');
        console.log(`TopicExtractor: Created ${groups.size} groups, ${ungroupedEntities.size} remain ungrouped`);

        const finalEntityMap = new Map();

        groups.forEach(group => {
            finalEntityMap.set(group.primaryForm, group.combinedAggregation);
        });

        ungroupedEntities.forEach((agg, text) => {
            finalEntityMap.set(text, agg);
        });

        console.log(`TopicExtractor: Final entity map contains ${finalEntityMap.size} entries`);
        // Ensure chunkTensors contains only valid, non-disposed tensors before returning
        const validChunkTensors = chunkTensors.filter(t => t && !t.isDisposed);
        console.log(`TopicExtractor: Returning ${validChunkTensors.length} valid chunk tensors.`);
        return { entityMap: finalEntityMap, chunkTensors: validChunkTensors };
    }

    averageEmbeddings(tensors) {
        console.log(`TopicExtractor: Averaging ${tensors.length} embeddings`);
        return tf.tidy(() => {
            if (tensors.length === 0)
                return tf.zeros([0]);
            const sum = tensors.reduce((acc, tensor) => acc.add(tensor));
            return sum.div(tensors.length);
        });
    }

    scoreAndSortEntities(entityMap, docEmbedding, topN, options) {
        console.log(`TopicExtractor: Scoring ${entityMap.size} entities`);
        return tf.tidy(() => {
            return Array.from(entityMap.entries())
                .map(([text, data]) => {
                    let similarity = 0; // Default similarity if no embedding exists
                    // Check if we have a valid embeddingSum and count to calculate average
                    if (data.embeddingSum && !data.embeddingSum.isDisposed && data.embeddingCount > 0) {
                        const avgEmbedding = data.embeddingSum.div(data.embeddingCount); // Use embeddingCount
                        similarity = this.cosineSimilarity(avgEmbedding, docEmbedding, options?.useL2Norm);
                        // avgEmbedding is temporary and managed by tf.tidy
                    } else if (data.embeddingSum && data.embeddingSum.isDisposed) {
                         console.warn(`Entity "${text}" embeddingSum was disposed before scoring.`);
                    } else {
                         console.warn(`Entity "${text}" has no valid embedding or embeddingCount is zero. Assigning similarity 0.`);
                    }


                    const entityGroups = new Map();

                    data.mentions.forEach(mention => {
                        const mentions = entityGroups.get(mention.type) || [];
                        mentions.push(mention);
                        entityGroups.set(mention.type, mentions);
                    });

                    return {
                        topic: text,
                        indices: [...new Set(data.indices)].sort((a, b) => a - b),
                        subcategories: Array.from(data.types).sort(),
                        relevanceScore: similarity, // Use calculated or default similarity
                        entityDetails: Array.from(entityGroups.entries())
                            .map(([type, mentions]) => ({
                                type: type,
                                mentions: mentions.sort((a, b) => a.start - b.start)
                            }))
                    };
                })
                .filter(topic => topic.indices.length > 0 && topic.subcategories.length > 0)
                .sort((a, b) => b.relevanceScore - a.relevanceScore)
                .slice(0, topN);
        });
    }

    cosineSimilarity(a, b, useL2Norm = false) {
        // Ensure input tensors are valid before proceeding
        if (!a || a.isDisposed || !b || b.isDisposed) {
            console.warn('Cosine Similarity: Input tensor disposed.');
            return 0;
        }

        return tf.tidy(() => {
            const aFlat = a.flatten();
            const bFlat = b.flatten();
            const dotProduct = aFlat.dot(bFlat);

            if (useL2Norm) { // If true, calculate dot product ONLY
                const dotResult = dotProduct.dataSync();
                return dotResult.length > 0 ? dotResult[0] : 0;
            } else { // Default: Calculate normalized cosine similarity
                const normA = aFlat.norm(); // Defined here
                const normB = bFlat.norm(); // Defined here

                // Check if norms are valid before multiplication
                if (normA.isDisposed || normB.isDisposed) {
                    console.warn('Cosine Similarity: Norm tensor disposed during calculation.');
                    return 0;
                }

                const normProduct = normA.mul(normB);

                // Prevent division by zero
                const normProductVal = normProduct.dataSync()[0];
                if (normProductVal === 0) {
                    return 0;
                }

                // Check if dotProduct is valid before division
                if (dotProduct.isDisposed) {
                     console.warn('Cosine Similarity: Dot product tensor disposed before division.');
                     return 0;
                }

                const similarity = dotProduct.div(normProduct);
                const similarityResult = similarity.dataSync();
                return similarityResult.length > 0 ? similarityResult[0] : 0;
            }
        });
    }

    chunkTextWithOverlap(text, maxTokens, overlapTokens) {
        console.log('TopicExtractor: Chunking text with overlap');
        const processedSentences = this.preprocessSentences(text, maxTokens);
        if (processedSentences.length === 0) {
            console.log('TopicExtractor: No sentences to process, returning empty chunk');
            return [{ text: '', offset: 0 }];
        }
        
        console.log(`TopicExtractor: Processing ${processedSentences.length} sentences`);
        const sentenceTokenCounts = processedSentences.map(s => this.entities.tokenizer.encode(s.sentence).length);
        const chunks = [];
        let currentChunkStartIdx = 0;
        
        while (currentChunkStartIdx < processedSentences.length) {
            const chunkResult = this.buildNextChunk(processedSentences, sentenceTokenCounts, currentChunkStartIdx, maxTokens);
            
            chunks.push({
                text: text.substring(chunkResult.start, chunkResult.end),
                offset: chunkResult.start
            });
            
            currentChunkStartIdx = this.calculateNextStart(chunkResult, processedSentences, sentenceTokenCounts, overlapTokens);
            
            if (currentChunkStartIdx <= chunkResult.originalStart) {
                currentChunkStartIdx = chunkResult.endIdx;
            }
        }
        
        console.log(`TopicExtractor: Created ${chunks.length} chunks`);
        return chunks;
    }

    // Add the missing preprocessSentences method
    preprocessSentences(text, maxTokens) {
        console.log('TopicExtractor: Preprocessing sentences');
        // Simple sentence splitting by common sentence terminators
        const sentenceRegex = /[.!?]+\s+/g;
        const sentenceBoundaries = [];
        let match;
        
        // Find all sentence boundaries
        while ((match = sentenceRegex.exec(text)) !== null) {
            sentenceBoundaries.push({
                end: match.index + match[0].length,
                separator: match[0]
            });
        }
        
        // Process the sentences
        const sentences = [];
        let startPos = 0;
        
        for (const boundary of sentenceBoundaries) {
            const sentence = text.substring(startPos, boundary.end);
            
            // Skip empty sentences or just whitespace
            if (sentence.trim().length > 0) {
                sentences.push({
                    sentence: sentence,
                    start: startPos,
                    end: boundary.end
                });
            }
            startPos = boundary.end;
        }
        
        // Add the last sentence if there's text remaining
        if (startPos < text.length) {
            const remainingText = text.substring(startPos);
            if (remainingText.trim().length > 0) {
                sentences.push({
                    sentence: remainingText,
                    start: startPos,
                    end: text.length
                });
            }
        }
        
        console.log(`TopicExtractor: Found ${sentences.length} sentences`);
        return sentences;
    }

    // Add the missing buildNextChunk method
    buildNextChunk(sentences, tokenCounts, startIdx, maxTokens) {
        console.log(`TopicExtractor: Building chunk starting from sentence ${startIdx}`);
        const originalStart = startIdx;
        let tokenCount = 0;
        let endIdx = startIdx;
        
        // Include sentences until we reach max tokens or run out of sentences
        while (endIdx < sentences.length && tokenCount + tokenCounts[endIdx] <= maxTokens) {
            tokenCount += tokenCounts[endIdx];
            endIdx++;
        }
        
        // If we can't even fit one sentence, just include it anyway
        if (endIdx === startIdx && startIdx < sentences.length) {
            endIdx = startIdx + 1;
        }
        
        const start = sentences[startIdx].start;
        const end = endIdx < sentences.length ? sentences[endIdx - 1].end : sentences[sentences.length - 1].end;
        
        return {
            originalStart,
            start,
            end,
            endIdx,
            tokenCount
        };
    }

    // Add the missing calculateNextStart method
    calculateNextStart(chunkResult, sentences, tokenCounts, overlapTokens) {
        console.log('TopicExtractor: Calculating next start for chunk');
        // Start with the end of the current chunk
        let nextStartIdx = chunkResult.endIdx;
        let overlapTokenCount = 0;
        
        // Walk backward to include some overlap
        while (nextStartIdx > chunkResult.originalStart && overlapTokenCount < overlapTokens) {
            nextStartIdx--;
            overlapTokenCount += tokenCounts[nextStartIdx];
        }
        
        return nextStartIdx;
    }

    getSubcategoriesFromEntity(entity) {
        const subcategories = new Set();
        subcategories.add(entity.type);
        
        switch (entity.type) {
            case 'PER':
                subcategories.add('named_entity');
                subcategories.add('person');
                break;
            case 'ORG':
                subcategories.add('named_entity');
                subcategories.add('organization');
                break;
            case 'LOC':
                subcategories.add('named_entity');
                subcategories.add('location');
                break;
        }
        
        return Array.from(subcategories);
    }

    mergeEntityTokens(nerTokens) {
        const mergedEntities = [];
        let currentEntity = null;
        
        for (const token of nerTokens) {
            const entityLabel = token.entity;
            const tokenWord = token.word;
            const tokenStart = token.start;
            const tokenEnd = token.end;
            const tokenType = entityLabel.startsWith('B-') || entityLabel.startsWith('I-')
                ? entityLabel.substring(2)
                : entityLabel;
            
            if (entityLabel === 'O') {
                if (currentEntity) {
                    mergedEntities.push(currentEntity);
                    currentEntity = null;
                }
            } else if (entityLabel.startsWith('B-')) {
                if (currentEntity) {
                    mergedEntities.push(currentEntity);
                }
                currentEntity = {
                    text: tokenWord,
                    type: tokenType,
                    start: tokenStart,
                    end: tokenEnd
                };
            } else if (entityLabel.startsWith('I-') && currentEntity) {
                if (currentEntity.type !== tokenType) {
                    if (currentEntity) {
                        mergedEntities.push(currentEntity);
                    }
                    currentEntity = {
                        text: tokenWord,
                        type: tokenType,
                        start: tokenStart,
                        end: tokenEnd
                    };
                    continue;
                }
                
                const currentEntityType = currentEntity.type || null;
                let parsedToken;
                
                if (tokenWord.startsWith('##')) {
                    parsedToken = tokenWord.substring(2);
                } else {
                    parsedToken = ' ' + tokenWord;
                }
                
                if (currentEntity && currentEntityType === tokenType) {
                    currentEntity.text += parsedToken;
                    currentEntity.end = tokenEnd;
                } else {
                    if (currentEntity) {
                        mergedEntities.push(currentEntity);
                    }
                    currentEntity = {
                        text: tokenWord,
                        type: tokenType,
                        start: tokenStart,
                        end: tokenEnd
                    };
                }
            } else {
                if (currentEntity) {
                    mergedEntities.push(currentEntity);
                }
                currentEntity = {
                    text: tokenWord,
                    type: entityLabel,
                    start: tokenStart,
                    end: tokenEnd
                };
            }
        }
        
        if (currentEntity) {
            mergedEntities.push(currentEntity);
        }
        
        return mergedEntities;
    }

    async getEntityEmbedding(text) {
        try {
            const embedding = await this.extractor(text, { pooling: 'mean' });
            return tf.tidy(() => {
                return this.convertTransformersTensor(embedding);
            });
        } catch (error) {
            console.error(`TopicExtractor: Error getting embedding for "${text}":`, error);
            // Return a zero tensor as fallback
            return tf.zeros([768]); // Assuming 768 is the embedding dimension
        }
    }

    normalizeEntityText(text) {
        return text.toLowerCase()
            .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    areEntitiesRelated(entity1, entity2, embed1, embed2) {
        const norm1 = this.normalizeEntityText(entity1);
        const norm2 = this.normalizeEntityText(entity2);
        
        if (norm1 === norm2) {
            return true;
        }
        if (norm1.includes(norm2) || norm2.includes(norm1)) {
            return true;
        }
        
        const similarity = this.cosineSimilarity(embed1, embed2);
        return similarity > 0.9;
    }

    findBestPrimaryForm(variations) {
        return variations.reduce((best, current) => current.length > best.length ? current : best);
    }

    async groupRelatedEntities(entityMap) {
        console.log(`TopicExtractor: Grouping ${entityMap.size} entities`);
        const groups = new Map();
        const ungroupedEntities = new Map();
        const processedEntities = new Set();
        const averageEmbeddings = new Map(); // Store calculated average embeddings
        const tensorsToDispose = []; // Keep track of tensors to dispose manually

        // Pre-calculate average embeddings for comparison - OUTSIDE tf.tidy
        console.log(`TopicExtractor: Calculating average embeddings for ${entityMap.size} entities for grouping`);
        entityMap.forEach((aggregation, text) => {
            // Check if embeddingSum exists, is not disposed, and embeddingCount > 0
            if (aggregation.embeddingSum && !aggregation.embeddingSum.isDisposed && aggregation.embeddingCount > 0) {
                // Calculate average embedding using embeddingCount
                const avgEmbedding = tf.tidy(() => aggregation.embeddingSum.div(aggregation.embeddingCount));
                averageEmbeddings.set(text, avgEmbedding);
                tensorsToDispose.push(avgEmbedding); // Track for later disposal
            } else {
                 // Handle cases where no valid average embedding can be calculated
                 if (aggregation.embeddingSum && aggregation.embeddingSum.isDisposed) {
                     console.warn(`Cannot calculate average embedding for grouping "${text}", embeddingSum disposed.`);
                 } else if (!aggregation.embeddingSum) {
                     console.warn(`Cannot calculate average embedding for grouping "${text}", embeddingSum missing.`);
                 } else { // embeddingCount is 0
                     console.warn(`Cannot calculate average embedding for grouping "${text}", embeddingCount is 0.`);
                 }
                 averageEmbeddings.set(text, null); // Mark as null if unusable
            }
        });
        console.log(`TopicExtractor: Calculated average embeddings for ${averageEmbeddings.size} potential entities for grouping`);

        let groupCount = 0;
        for (const [entityText, aggregation] of entityMap.entries()) {
            if (processedEntities.has(entityText))
                continue;

            const relatedEntities = new Set([entityText]);
            const relatedAggregations = [aggregation]; // Store the full aggregation data

            for (const [otherText, otherAgg] of entityMap.entries()) {
                if (otherText === entityText || processedEntities.has(otherText))
                    continue;

                // Use the pre-calculated average embeddings
                const embed1 = averageEmbeddings.get(entityText);
                const embed2 = averageEmbeddings.get(otherText);

                // Ensure embeddings exist (are not null) and are valid tensors before comparing
                if (!embed1 || !embed2 || !(embed1 instanceof tf.Tensor) || !(embed2 instanceof tf.Tensor)) {
                    continue; // Skip comparison if either embedding is invalid/missing
                }

                // Check if tensors might have been disposed unexpectedly (debugging)
                if (embed1.isDisposed || embed2.isDisposed) {
                    console.warn(`Tensor already disposed before comparison: ${entityText} or ${otherText}`);
                    continue;
                }

                // Use the existing areEntitiesRelated logic which calls cosineSimilarity
                if (this.areEntitiesRelated(entityText, otherText, embed1, embed2)) {
                    const entityTypes1 = aggregation.types;
                    const entityTypes2 = otherAgg.types;
                    const hasCompatibleTypes = Array.from(entityTypes1).some(t => entityTypes2.has(t));

                    if (hasCompatibleTypes) {
                        relatedEntities.add(otherText);
                        relatedAggregations.push(otherAgg); // Add the full aggregation
                        processedEntities.add(otherText);
                    }
                }
            }

            if (relatedEntities.size > 1) {
                groupCount++;
                const primaryForm = this.findBestPrimaryForm(Array.from(relatedEntities));
                // Pass the collected aggregations to mergeAggregations
                const combinedAggregation = this.mergeAggregations(relatedAggregations);

                groups.set(primaryForm, {
                    primaryForm,
                    variations: relatedEntities,
                    combinedAggregation // Store the merged result
                });
                 // Dispose original embeddingSum from merged aggregations if they are not needed anymore
                 // This is complex; safer to let final cleanup handle it.

            } else {
                // Add the original aggregation to ungrouped if it wasn't grouped
                ungroupedEntities.set(entityText, aggregation);
            }

            processedEntities.add(entityText);
        }

        console.log(`TopicExtractor: Created ${groupCount} entity groups`);

        // Dispose the average embeddings used specifically for grouping comparisons
        console.log(`TopicExtractor: Disposing ${tensorsToDispose.length} average embedding tensors used for grouping.`);
        tensorsToDispose.forEach(tensor => {
            if (tensor && !tensor.isDisposed) {
                tensor.dispose();
            }
        });

        // Note: The original embeddingSum tensors within the aggregations
        // in `groups` and `ungroupedEntities` are NOT disposed here yet.
        // They are needed for the final scoring step (or were potentially merged).

        return { groups, ungroupedEntities };
    }

    mergeAggregations(aggregations) {
        let combinedSum = null;
        let totalEmbeddingCount = 0;
        let firstShape = null;

        // Find the first valid embedding sum to get the shape and initialize
        for (const agg of aggregations) {
            if (agg.embeddingSum && !agg.embeddingSum.isDisposed && agg.embeddingCount > 0) {
                firstShape = agg.embeddingSum.shape;
                combinedSum = tf.zeros(firstShape); // Initialize with zeros
                break;
            }
        }

        // If no aggregation had a valid embedding, the combined sum remains null
        if (combinedSum) {
            // Keep track of the tensor across tidy scopes
            let tempSum = combinedSum;
            tf.tidy(() => { // Tidy scope for intermediate tensors during summation
                aggregations.forEach(agg => {
                    if (agg.embeddingSum && !agg.embeddingSum.isDisposed && agg.embeddingCount > 0) {
                         // Ensure shape matches before adding
                         if (JSON.stringify(agg.embeddingSum.shape) === JSON.stringify(firstShape)) {
                             const currentSum = tempSum; // Use the tracked tensor
                             tempSum = currentSum.add(agg.embeddingSum); // Update the tracked tensor
                             currentSum.dispose(); // Dispose previous intermediate sum
                             totalEmbeddingCount += agg.embeddingCount;
                         } else {
                              console.warn(`Shape mismatch during mergeAggregations. Expected ${JSON.stringify(firstShape)}, got ${JSON.stringify(agg.embeddingSum.shape)}. Skipping.`);
                         }
                    }
                });
            });
             // Assign the final result back to combinedSum
             combinedSum = tempSum;
             // Ensure the final tensor is kept
             tf.keep(combinedSum);

        } else {
             console.warn("Could not create combined embeddingSum during merge, no valid source embeddings found.");
             // Optionally create a zero tensor if a default shape is known/acceptable
             // combinedSum = tf.zeros(DEFAULT_SHAPE);
        }


        return {
            indices: [...new Set(aggregations.flatMap(agg => agg.indices))].sort((a, b) => a - b),
            types: new Set(aggregations.flatMap(agg => Array.from(agg.types))),
            embeddingSum: combinedSum, // The final calculated sum (or null)
            count: aggregations.reduce((sum, agg) => sum + agg.count, 0), // Total mention count
            embeddingCount: totalEmbeddingCount, // Total count of embeddings summed
            mentions: aggregations.flatMap(agg => agg.mentions)
        };
    }
}

// Export a convenient helper function for the web worker
export async function extractTopics(text, topN = 5, options = {}, isChromium = false) {
    console.log(`extractTopics called: text length=${text.length}, topN=${topN}, isChromium=${isChromium}`, options);
    console.time('topic-extraction-total');
    
    const extractor = new TopicExtractor();
    try {
        console.log('Initializing TopicExtractor');
        console.time('topic-extractor-init');
        await extractor.initialize(isChromium);
        console.timeEnd('topic-extractor-init');
        
        console.log('Extracting main topics');
        console.time('extract-main-topics');
        const topics = await extractor.extractMainTopics(text, topN, {
            useCentrality: false,
            useL2Norm: true,
            useSectionEmbeddings: false,
            ...options
        });
        console.timeEnd('extract-main-topics');
        
        console.log('Topic extraction complete:', topics);
        console.timeEnd('topic-extraction-total');
        return topics;
    } catch (error) {
        console.error('Error extracting topics:', error);
        console.timeEnd('topic-extraction-total');
        throw error;
    }
};