import { describe, expect, it } from "vitest";
import { buildClipTokenizerJson, clipMerges } from "../../src/lib/cliptok";


describe("clip tokenizer built from vocab.json + merges.txt", () => {
  // A miniature CLIP vocabulary: enough to check the template (bos/eos, the
  // normalizer, the "a b" merge format) without shipping a 1.4 MB fixture.
  const vocab: Record<string, number> = {
    "<|startoftext|>": 0,
    "<|endoftext|>": 1,
    a: 2,
    b: 3,
    ab: 4,
    "ab</w>": 5,
    c: 6,
    "a</w>": 7,
    "b</w>": 8,
    "c</w>": 9,
    "!": 10,
    "!</w>": 11,
  };
  const merges = "#version: 0.2\na b\n";

  it("produces the same ids as the canonical fast-tokenizer file", async () => {
    const { PreTrainedTokenizer } = await import("@huggingface/transformers");
    const config = { model_max_length: 77, pad_token: "<|endoftext|>" };
    const built = new PreTrainedTokenizer(buildClipTokenizerJson(vocab, merges) as never, config as never);
    // The very same structure Hugging Face publishes for CLIP models.
    const canonical = new PreTrainedTokenizer(
      {
        ...buildClipTokenizerJson(vocab, merges),
        model: { ...buildClipTokenizerJson(vocab, merges).model, merges: ["a b"] },
      } as never,
      config as never,
    );
    for (const text of ["ab", "AB", "a b!", "  spaced   out  ", "unknown 汉"]) {
      const a = Array.from(built(text, { padding: "max_length", truncation: true, max_length: 8 }).input_ids.data);
      const b = Array.from(canonical(text, { padding: "max_length", truncation: true, max_length: 8 }).input_ids.data);
      expect(a).toEqual(b);
      expect(Number(a[0])).toBe(0); // <|startoftext|>
      expect(a).toHaveLength(8); // padded to the context length
      expect(Number(a.at(-1))).toBe(1); // ... with <|endoftext|>
    }
    // Nothing but <|startoftext|> + <|endoftext|>: the empty prompt is all padding.
    const empty = Array.from(built("", { padding: "max_length", truncation: true, max_length: 8 }).input_ids.data);
    expect(empty.map(Number)).toEqual([0, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("keeps the CLIP geometry", () => {
    const json = buildClipTokenizerJson(vocab, merges);
    expect(json.model.merges).toEqual(["a b"]); // the #version header is dropped
    expect(json.added_tokens.map((t) => t.id)).toEqual([0, 1]);
    expect(json.post_processor).toMatchObject({ type: "RobertaProcessing", cls: ["<|startoftext|>", 0], sep: ["<|endoftext|>", 1] });
    expect(json.model.unk_token).toBe("<|endoftext|>");
    // Real CLIP vocabularies carry the same two special ids.
    const real = buildClipTokenizerJson({ "<|startoftext|>": 49406, "<|endoftext|>": 49407, a: 1 }, "");
    expect(real.added_tokens.map((t) => t.id)).toEqual([49406, 49407]);
  });
});

