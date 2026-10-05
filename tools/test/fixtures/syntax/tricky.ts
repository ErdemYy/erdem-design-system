// import { fake } from './comment-import';
/* require('./block-comment') */
const a = "import { fake } from './string-import'";
const b = `
  import x from './template-import';
  ${"require('./nested-string')"}
`;
const re = /import\s+from\s+'.\/regex-import'/;
const ok = require('./real');
import('./real-dynamic');
import(computed());
export { ok };
