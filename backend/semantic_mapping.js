// Browser-compatible semantic mapping implementation
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
                quantized: true,
            });
            console.timeEnd('feature-extraction-model-load');
            console.log('TopicExtractor: Feature extraction model loaded successfully');
            
            console.log('TopicExtractor: Loading NER model');
            console.time('ner-model-load');
            this.entities = await pipeline('ner', 'Xenova/distilbert-base-multilingual-cased-ner-hrl', {
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
        const { entityMap, chunkTensors } = await this.aggregateEntities(processedChunks);
        console.timeEnd('aggregate-entities');
        console.log(`TopicExtractor: Found ${entityMap.size} unique entities`);
        
        console.log('TopicExtractor: Computing document embedding');
        console.time('doc-embedding');
        const docEmbedding = this.averageEmbeddings(chunkTensors);
        console.timeEnd('doc-embedding');
        
        console.log('TopicExtractor: Scoring and sorting entities');
        console.time('scoring');
        const results = this.scoreAndSortEntities(entityMap, docEmbedding, topN, options);
        console.timeEnd('scoring');
        console.log(`TopicExtractor: Selected top ${results.length} topics`);
        
        console.log('TopicExtractor: Cleaning up tensors');
        chunkTensors.forEach(t => t.dispose());
        docEmbedding.dispose();
        entityMap.forEach(agg => agg.embeddingSum.dispose());
        
        console.timeEnd('extract-topics-total');
        console.log('TopicExtractor: Topic extraction complete', results);
        return results;
    }

    async processChunks(chunks) {
        console.log(`TopicExtractor: Processing ${chunks.length} chunks`);
        return Promise.all(chunks.map(async (chunk, index) => {
            console.log(`TopicExtractor: Processing chunk ${index+1}/${chunks.length}, length=${chunk.text.length}`);
            try {
                console.time(`chunk-${index}-processing`);
                
                console.time(`chunk-${index}-embedding`);
                const embeddingTensor = await this.extractor(chunk.text, { pooling: 'mean' });
                console.timeEnd(`chunk-${index}-embedding`);
                
                console.time(`chunk-${index}-ner`);
                const nerResults = await this.entities(chunk.text);
                console.timeEnd(`chunk-${index}-ner`);
                console.log(`TopicExtractor: Chunk ${index+1} - Found ${nerResults.length} entity tokens`);
                
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
                console.log(`TopicExtractor: Chunk ${index+1} - Merged into ${mergedEntities.length} entities`);
                
                console.timeEnd(`chunk-${index}-processing`);
                return {
                    embeddings: this.convertTransformersTensor(embeddingTensor),
                    entities: mergedEntities
                };
            } catch (error) {
                console.error(`TopicExtractor: Error processing chunk ${index}:`, error);
                throw error;
            }
        }));
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
            throw new Error('Failed to convert tensor: ' + error.message);
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
        const chunkTensors = [];
        
        chunks.forEach(chunk => {
            chunkTensors.push(chunk.embeddings);
            chunk.entities.forEach(entity => {
                const key = entity.text.toLowerCase();
                const existing = entityMap.get(key) ?? {
                    indices: [],
                    types: new Set(),
                    embeddingSum: tf.zeros(chunk.embeddings.shape),
                    count: 0,
                    mentions: []
                };
                
                const newSum = tf.tidy(() => {
                    return existing.embeddingSum.add(chunk.embeddings);
                });
                
                if (existing.embeddingSum) {
                    existing.embeddingSum.dispose();
                }
                
                existing.embeddingSum = newSum;
                existing.indices.push(entity.start);
                this.getSubcategoriesFromEntity(entity).forEach(type => existing.types.add(type));
                existing.mentions.push({
                    text: entity.text,
                    start: entity.start,
                    end: entity.end,
                    type: entity.type
                });
                existing.count++;
                entityMap.set(key, existing);
            });
        });
        console.log(`TopicExtractor: Found ${entityMap.size} unique entities before grouping`);
        
        console.log('TopicExtractor: Grouping related entities');
        console.time('group-entities');
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
        return { entityMap: finalEntityMap, chunkTensors };
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
                    const avgEmbedding = data.embeddingSum.div(data.count);
                    const similarity = this.cosineSimilarity(avgEmbedding, docEmbedding, options?.useL2Norm);
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
                        relevanceScore: similarity,
                        entityDetails: Array.from(entityGroups.entries())
                            .map(([type, mentions]) => ({
                                type,
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
        return tf.tidy(() => {
            const aFlat = a.flatten();
            const bFlat = b.flatten();
            const dotProduct = aFlat.dot(bFlat);
            
            if (useL2Norm) {
                return dotProduct.dataSync()[0];
            } else {
                const normA = aFlat.norm();
                const normB = bFlat.norm();
                return dotProduct.div(normA.mul(normB)).dataSync()[0] || 0;
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
            return tf.zeros([768]);
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
        
        if (norm1 === norm2)
            return true;
        if (norm1.includes(norm2) || norm2.includes(norm1))
            return true;
        
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
        const entityEmbeddings = new Map();
        
        console.log('TopicExtractor: Getting embeddings for entities');
        await Promise.all(Array.from(entityMap.entries()).map(async ([text, _]) => {
            entityEmbeddings.set(text, await this.getEntityEmbedding(text));
        }));
        console.log(`TopicExtractor: Got embeddings for ${entityEmbeddings.size} entities`);
        
        let groupCount = 0;
        for (const [entityText, aggregation] of entityMap.entries()) {
            if (processedEntities.has(entityText))
                continue;
            
            const relatedEntities = new Set([entityText]);
            const relatedAggregations = [aggregation];
            
            for (const [otherText, otherAgg] of entityMap.entries()) {
                if (otherText === entityText || processedEntities.has(otherText))
                    continue;
                
                const embed1 = entityEmbeddings.get(entityText);
                const embed2 = entityEmbeddings.get(otherText);
                
                if (this.areEntitiesRelated(entityText, otherText, embed1, embed2)) {
                    const entityTypes1 = aggregation.types;
                    const entityTypes2 = otherAgg.types;
                    const hasCompatibleTypes = Array.from(entityTypes1).some(t => entityTypes2.has(t));
                    
                    if (hasCompatibleTypes) {
                        relatedEntities.add(otherText);
                        relatedAggregations.push(otherAgg);
                        processedEntities.add(otherText);
                    }
                }
            }
            
            if (relatedEntities.size > 1) {
                groupCount++;
                const primaryForm = this.findBestPrimaryForm(Array.from(relatedEntities));
                const combinedAggregation = this.mergeAggregations(relatedAggregations);
                
                groups.set(primaryForm, {
                    primaryForm,
                    variations: relatedEntities,
                    combinedAggregation
                });
            } else {
                ungroupedEntities.set(entityText, aggregation);
            }
            
            processedEntities.add(entityText);
        }
        
        console.log(`TopicExtractor: Created ${groupCount} entity groups`);
        entityEmbeddings.forEach(tensor => tensor.dispose());
        return { groups, ungroupedEntities };
    }

    mergeAggregations(aggregations) {
        return {
            indices: [...new Set(aggregations.flatMap(agg => agg.indices))],
            types: new Set(aggregations.flatMap(agg => Array.from(agg.types))),
            embeddingSum: tf.tidy(() => {
                const sum = aggregations.reduce((acc, agg) => acc.add(agg.embeddingSum), tf.zeros(aggregations[0].embeddingSum.shape));
                return sum.div(aggregations.length);
            }),
            count: aggregations.reduce((sum, agg) => sum + agg.count, 0),
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
}