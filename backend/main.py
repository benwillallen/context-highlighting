"""
Where the backend server will go
"""

from fastapi import FastAPI
from pydantic import BaseModel
from extract import extract_key_sentences

app = FastAPI()

class TextRequest(BaseModel):
    text: str
    
class SentenceResponse(BaseModel):
    key_sentences: list[str]
    
@app.post("/", response_model=SentenceResponse)
async def extract_sentences(request: TextRequest):
    key_sentences = extract_key_sentences(
        request.text
    )
    return {"key_sentences": key_sentences}

