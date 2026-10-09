// Stable-diffusion repos ship the CLIP tokenizer as `vocab.json` + `merges.txt`
// (the "slow" tokenizer files). Transformers.js wants the *fast* tokenizer layout
// (a single tokenizer.json), so we assemble the very same structure Hugging Face
// publishes for CLIP — verified to produce identical ids (see the unit tests).

export interface ClipTokenizerJson {
  version: string;
  truncation: null;
  padding: null;
  added_tokens: Array<{
    id: number;
    special: boolean;
    content: string;
    single_word: boolean;
    lstrip: boolean;
    rstrip: boolean;
    normalized: boolean;
  }>;
  normalizer: unknown;
  pre_tokenizer: unknown;
  post_processor: unknown;
  decoder: unknown;
  model: {
    type: "BPE";
    dropout: null;
    unk_token: string;
    continuing_subword_prefix: string;
    end_of_word_suffix: string;
    fuse_unk: boolean;
    vocab: Record<string, number>;
    merges: string[];
  };
}

/** The GPT-2 / CLIP pre-tokenisation pattern. */
const CLIP_PATTERN = "<\\|startoftext\\|>|<\\|endoftext\\|>|'s|'t|'re|'ve|'m|'ll|'d|[\\p{L}]+|[\\p{N}]|[^\\s\\p{L}\\p{N}]+";

export const clipMerges = (mergesText: string): string[] =>
  mergesText
    .split("\n")
    .filter((line) => line && !line.startsWith("#version"))
    .map((line) => line.trimEnd());

export function buildClipTokenizerJson(vocab: Record<string, number>, mergesText: string): ClipTokenizerJson {
  const bosId = vocab["<|startoftext|>"] ?? 49406;
  const eosId = vocab["<|endoftext|>"] ?? 49407;
  return {
    version: "1.0",
    truncation: null,
    padding: null,
    added_tokens: [
      { id: bosId, special: true, content: "<|startoftext|>", single_word: false, lstrip: false, rstrip: false, normalized: true },
      { id: eosId, special: true, content: "<|endoftext|>", single_word: false, lstrip: false, rstrip: false, normalized: false },
    ],
    normalizer: {
      type: "Sequence",
      normalizers: [
        { type: "NFC" },
        { type: "Replace", pattern: { Regex: "\\s+" }, content: " " },
        { type: "Lowercase" },
      ],
    },
    pre_tokenizer: {
      type: "Sequence",
      pretokenizers: [
        { type: "Split", pattern: { Regex: CLIP_PATTERN }, behavior: "Removed", invert: true },
        { type: "ByteLevel", add_prefix_space: false, trim_offsets: true },
      ],
    },
    post_processor: {
      type: "RobertaProcessing",
      sep: ["<|endoftext|>", eosId],
      cls: ["<|startoftext|>", bosId],
      trim_offsets: false,
      add_prefix_space: false,
    },
    decoder: { type: "ByteLevel", add_prefix_space: true, trim_offsets: true },
    model: {
      type: "BPE",
      dropout: null,
      unk_token: "<|endoftext|>",
      continuing_subword_prefix: "",
      end_of_word_suffix: "</w>",
      fuse_unk: false,
      vocab,
      merges: clipMerges(mergesText),
    },
  };
}
