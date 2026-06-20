"""DeepSeek tokenizer microservice.

Loads the official DeepSeek tokenizer (tokenizer.json) once and exposes a tiny
HTTP API so the Node app can get exact token counts (and therefore exact API
cost in tokens). Uses the lightweight `tokenizers` library — the produced token
ids are identical to the official transformers AutoTokenizer.
"""
import os
from fastapi import FastAPI
from pydantic import BaseModel
from tokenizers import Tokenizer

TOK_PATH = os.path.join(os.path.dirname(__file__), "tokenizer.json")
tokenizer = Tokenizer.from_file(TOK_PATH)

app = FastAPI(title="DeepSeek tokenizer", version="1.0.0")


class CountIn(BaseModel):
    text: str = ""


class BatchIn(BaseModel):
    texts: list[str] = []


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/count")
def count(body: CountIn):
    return {"tokens": len(tokenizer.encode(body.text).ids)}


@app.post("/count_batch")
def count_batch(body: BatchIn):
    encs = tokenizer.encode_batch(body.texts)
    return {"tokens": [len(e.ids) for e in encs]}
