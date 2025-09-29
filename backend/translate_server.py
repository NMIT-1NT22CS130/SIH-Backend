from flask import Flask, request, jsonify
import torch
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
from IndicTransToolkit.processor import IndicProcessor

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
MODEL_NAME = "ai4bharat/indictrans2-en-indic-1B"  # English → Indic
tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME, trust_remote_code=True)
model = AutoModelForSeq2SeqLM.from_pretrained(
    MODEL_NAME,
    trust_remote_code=True,
    torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
).to(DEVICE)
ip = IndicProcessor(inference=True)

app = Flask(__name__)

@app.route("/translate", methods=["POST"])
def translate():
    data = request.json
    sentences = data.get("sentences", [])
    src_lang = "eng_Latn"
    tgt_lang = "pan_Guru"  # Punjabi

    if not sentences:
        return jsonify({"error": "No input sentences"}), 400

    # preprocess
    batch = ip.preprocess_batch(sentences, src_lang=src_lang, tgt_lang=tgt_lang)

    # tokenize
    inputs = tokenizer(batch, padding="longest", return_tensors="pt").to(DEVICE)

    # generate
    with torch.no_grad():
        outputs = model.generate(**inputs, max_length=256, num_beams=1,use_cache=False)

    # decode + postprocess
    translations = tokenizer.batch_decode(outputs, skip_special_tokens=True)
    translations = ip.postprocess_batch(translations, lang=tgt_lang)

    return jsonify({"translations": translations})

if __name__ == "__main__":
    app.run(port=5000)
