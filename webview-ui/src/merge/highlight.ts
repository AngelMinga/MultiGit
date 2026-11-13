// Colores de sintaxis para la ventana de merge (como el editor): highlight.js con solo los lenguajes
// habituales, para no cargar todos. Devuelve HTML ya escapado.
import hljs from 'highlight.js/lib/core';
import css from 'highlight.js/lib/languages/css';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import bash from 'highlight.js/lib/languages/bash';
import dart from 'highlight.js/lib/languages/dart';
import go from 'highlight.js/lib/languages/go';
import csharp from 'highlight.js/lib/languages/csharp';
import php from 'highlight.js/lib/languages/php';
import swift from 'highlight.js/lib/languages/swift';

for (const [name, lang] of Object.entries({ css, java, javascript, json, kotlin, markdown, python, scss, sql, typescript, xml, yaml, bash, dart, go, csharp, php, swift })) {
  hljs.registerLanguage(name, lang);
}

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', css: 'css', scss: 'scss', less: 'scss',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  java: 'java', kt: 'kotlin', kts: 'kotlin', py: 'python', md: 'markdown',
  yml: 'yaml', yaml: 'yaml', sql: 'sql', sh: 'bash', zsh: 'bash', dart: 'dart', go: 'go', cs: 'csharp', php: 'php', swift: 'swift',
};

/** Lenguaje de highlight.js para un archivo, o undefined (texto plano). */
export function languageOf(filePath: string): string | undefined {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
  return BY_EXTENSION[ext];
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** HTML coloreado de un trozo de código (sin lenguaje, o si falla, solo escapado). */
export function highlight(code: string, language: string | undefined): string {
  if (!language || !code) return escape(code);
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escape(code);
  }
}
