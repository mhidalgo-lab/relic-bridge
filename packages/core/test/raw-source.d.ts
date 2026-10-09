// SPDX-License-Identifier: Apache-2.0
// Vite's `?raw` import: a source file's text (the sibling-metadata test reads the tool sources).
declare module '*?raw' {
  const text: string;
  export default text;
}
