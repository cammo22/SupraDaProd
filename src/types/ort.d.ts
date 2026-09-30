// `ort` is an npm alias for onnxruntime-web@1.30 (see package.json); its own
// typings only declare the ambient module name "onnxruntime-web".
declare module "ort" {
  export * from "onnxruntime-common";
}
