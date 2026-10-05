import { add } from '../util';

export default function Button() {
  // JSX text with an apostrophe: Don't confuse the tokenizer
  return <button onClick={() => add(1, 2)}>Don't click</button>;
}
