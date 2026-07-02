// Type shims for static assets embedded via Bun import attributes
// (`import x from "./f.css" with { type: "text" }`). tsc does not model import
// attributes, so without these the imports are unresolved (.css/.jpeg) or typed
// as the JS module / HTMLBundle. At runtime Bun returns the file contents as a
// string for `type: "text"` and a path for `type: "file"`.
declare module "*.css" {
  const content: string;
  export default content;
}
declare module "*.js" {
  const content: string;
  export default content;
}
declare module "*.jpeg" {
  const content: string;
  export default content;
}
