/**
 * Entry module of the fixture app. Wires everything together.
 */
import { add } from './util';
import Button from './components/Button';
import legacy from './legacy.js';
import type { T } from './types';
import '@/side';
import React from 'react';
import './styles/main.css';

export * from './util';
export { default as Btn } from './components/Button';
export const main = (x: T) => add(1, 2) + legacy + String(x) + String(React) + String(Button);

export const lazy = () => import('./lazy');
const cjs = require('./cjs.cjs');
export default cjs;
