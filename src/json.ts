export function parseJson(text: string): unknown {
  return JSON.parse(text.replace(/^﻿/, ''));
}