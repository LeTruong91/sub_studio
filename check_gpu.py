from ocr.engine import load_engine, current_ocr_device

load_engine(use_gpu=True)
print("OCR device:", current_ocr_device())