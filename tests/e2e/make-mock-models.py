#!/usr/bin/env python3
"""Generates a tiny, *fake* Supra2-IMG hub repo for end-to-end tests.

Same file layout and tensor names as the real ONNX pipeline, but the networks
are a few KB of random weights — so the whole app (download → resume → worker →
sampler → gallery) can be exercised in CI without pulling 1 GB from Hugging Face.

usage: make-mock-models.py <out_dir>
"""
import json
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto as TP
from onnx import helper as h
from onnx import numpy_helper as nh

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(1234)

L, D = 16, 16  # ctx_len, hidden
C, S = 4, 8  # latent channels, latent size
IMG = 64  # image size
VOCAB = 260


def init(name, arr):
    return nh.from_array(np.asarray(arr, dtype=np.float32), name)


def save(graph, name):
    model = h.make_model(graph, opset_imports=[h.make_opsetid("", 17)])
    model.ir_version = 9
    onnx.checker.check_model(model)
    onnx.save(model, out / name)


# ---- T5 encoder: Gather(embedding) * mask ----------------------------------
emb = init("emb", rng.normal(0, 1, (VOCAB, D)))
t5 = h.make_graph(
    [
        h.make_node("Gather", ["emb", "input_ids"], ["g"]),
        h.make_node("Cast", ["attention_mask"], ["mf"], to=TP.FLOAT),
        h.make_node("Unsqueeze", ["mf", "ax2"], ["mu"]),
        h.make_node("Mul", ["g", "mu"], ["last_hidden_state"]),
    ],
    "t5",
    [
        h.make_tensor_value_info("input_ids", TP.INT64, [1, L]),
        h.make_tensor_value_info("attention_mask", TP.INT64, [1, L]),
    ],
    [h.make_tensor_value_info("last_hidden_state", TP.FLOAT, [1, L, D])],
    [emb, nh.from_array(np.array([2], dtype=np.int64), "ax2")],
)
save(t5, "t5.onnx")

# ---- DiT: v = tanh(mean(ctx)·W + B + t·0.1) - z  (an ODE that converges to an image) --
# Two flavours with the *same* weights:
#   dit.onnx     → fixed batch of 1 (the default path, one call per branch)
#   dit-dyn.onnx → dynamic batch (lets the e2e check batched guidance end to end)
W = init("W", rng.normal(0, 4, (1, C, 1, 1)))
B = init("B", rng.normal(0, 0.8, (1, C, S, S)))
k01 = init("k01", np.array([0.02], dtype=np.float32).reshape(1, 1, 1, 1))
ax1 = nh.from_array(np.array([1], dtype=np.int64), "ax1")
ax123 = nh.from_array(np.array([1, 2, 3], dtype=np.int64), "ax123")
ax12 = nh.from_array(np.array([1, 2], dtype=np.int64), "ax12")
# Unused ballast so the file is big enough (~6 MB) to exercise chunked / resumed downloads.
ballast = init("ballast", rng.normal(0, 1, (1_500_000,)))

dit_ops = [
    h.make_node("ReduceMean", ["ctx"], ["m"], axes=[1, 2], keepdims=1),  # [B,1,1]
    h.make_node("ReduceSum", ["ctx_mask", "ax1"], ["ms"], keepdims=1),  # [B,1]
    h.make_node("Unsqueeze", ["t", "ax123"], ["t4"]),  # [B,1,1,1]
    h.make_node("Unsqueeze", ["ms", "ax12"], ["ms4"]),  # [B,1,1,1]
    h.make_node("Mul", ["m", "W"], ["mw"]),  # [B,C,1,1]
    h.make_node("Mul", ["ms4", "k01"], ["msk"]),
    h.make_node("Mul", ["t4", "k01"], ["tk"]),
    h.make_node("Add", ["mw", "B"], ["a1"]),
    h.make_node("Add", ["a1", "msk"], ["a2"]),
    h.make_node("Add", ["a2", "tk"], ["a3"]),
    h.make_node("Tanh", ["a3"], ["target"]),
    h.make_node("Sub", ["target", "z"], ["v"]),
]
dit_weights = [ax1, ax123, ax12, ballast, W, B, k01]


def dit_model(batch, name):
    return h.make_graph(
        dit_ops,
        name,
        [
            h.make_tensor_value_info("z", TP.FLOAT, [batch, C, S, S]),
            h.make_tensor_value_info("t", TP.FLOAT, [batch]),
            h.make_tensor_value_info("ctx", TP.FLOAT, [batch, L, D]),
            h.make_tensor_value_info("ctx_mask", TP.FLOAT, [batch, L]),
        ],
        [h.make_tensor_value_info("v", TP.FLOAT, [batch, C, S, S])],
        dit_weights,
    )


save(dit_model(1, "dit"), "dit.onnx")
save(dit_model(None, "dit-dyn"), "dit-dyn.onnx")

# ---- VAE decoder: 1x1 conv (4→3) + nearest upsample ×8 ----------------------
vae = h.make_graph(
    [
        h.make_node("Conv", ["z", "cw", "cb"], ["c"]),
        h.make_node("Resize", ["c", "", "scales"], ["up"], mode="nearest"),
        h.make_node("Tanh", ["up"], ["image"]),
    ],
    "vae",
    [h.make_tensor_value_info("z", TP.FLOAT, [1, C, S, S])],
    [h.make_tensor_value_info("image", TP.FLOAT, [1, 3, IMG, IMG])],
    [
        init("cw", rng.normal(0, 1.2, (3, C, 1, 1))),
        init("cb", np.zeros(3)),
        init("scales", np.array([1, 1, IMG // S, IMG // S])),
    ],
)
save(vae, "vae.onnx")

# ---- config + tokenizer -------------------------------------------------------
(out / "pipeline_config.json").write_text(
    json.dumps(
        {
            "dit": "dit.onnx",
            "text_encoder": "t5.onnx",
            "vae_decoder": "vae.onnx",
            "ctx_len": L,
            "latent_ch": C,
            "latent_size": S,
            "vae_scale": 0.18215,
            "image_size": IMG,
        }
    )
)

vocab = [["<pad>", 0.0], ["</s>", 0.0], ["<unk>", 0.0], ["▁", -2.0]]
chars = "abcdefghijklmnopqrstuvwxyz0123456789.,'-àèéìòù"
for ch in chars:
    vocab.append([ch, -5.0])
    vocab.append(["▁" + ch, -4.5])
for w in ["a", "the", "cat", "fox", "dragon", "robot", "sea", "of", "in", "on", "moon"]:
    vocab.append(["▁" + w, -3.0])
assert len(vocab) < VOCAB, len(vocab)


def special(i, c):
    return {"id": i, "content": c, "single_word": False, "lstrip": False, "rstrip": False, "normalized": False, "special": True}


tok = {
    "version": "1.0",
    "truncation": None,
    "padding": None,
    "added_tokens": [special(0, "<pad>"), special(1, "</s>"), special(2, "<unk>")],
    "normalizer": {"type": "Sequence", "normalizers": [{"type": "Replace", "pattern": {"Regex": " {2,}"}, "content": " "}]},
    "pre_tokenizer": {"type": "Metaspace", "replacement": "▁", "prepend_scheme": "always", "split": True},
    "post_processor": {
        "type": "TemplateProcessing",
        "single": [{"Sequence": {"id": "A", "type_id": 0}}, {"SpecialToken": {"id": "</s>", "type_id": 0}}],
        "pair": [
            {"Sequence": {"id": "A", "type_id": 0}},
            {"SpecialToken": {"id": "</s>", "type_id": 0}},
            {"Sequence": {"id": "B", "type_id": 0}},
            {"SpecialToken": {"id": "</s>", "type_id": 0}},
        ],
        "special_tokens": {"</s>": {"id": "</s>", "ids": [1], "tokens": ["</s>"]}},
    },
    "decoder": {"type": "Metaspace", "replacement": "▁", "prepend_scheme": "always", "split": True},
    "model": {"type": "Unigram", "unk_id": 2, "vocab": vocab, "byte_fallback": False},
}
(out / "tokenizer.json").write_text(json.dumps(tok, ensure_ascii=False))
(out / "tokenizer_config.json").write_text(
    json.dumps(
        {
            "tokenizer_class": "T5Tokenizer",
            "eos_token": "</s>",
            "pad_token": "<pad>",
            "unk_token": "<unk>",
            "model_max_length": 512,
            "extra_ids": 0,
            "additional_special_tokens": [],
            "clean_up_tokenization_spaces": True,
        }
    )
)
print("mock hub written to", out)
