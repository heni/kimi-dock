/*
 * Unit tests for the shared markdown renderer (chat messages + artifact
 * preview). Run: npm run test:unit
 *
 * The security posture is part of the contract: raw HTML stays escaped
 * (html: false) and javascript: links are neutralized by markdown-it's
 * link validator; TeX goes through KaTeX with trust: false (default) and
 * throwOnError: false (a broken formula must not fail the message).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { md } from '../.tmp/unit-build/renderer/src/utils/markdown.js'

test('bold, headers and lists render to HTML', () => {
  const html = md.render('## Title\n\n**bold** and:\n\n1. one\n2. two\n\n- a\n- b\n')
  assert.match(html, /<h2>Title<\/h2>/)
  assert.match(html, /<strong>bold<\/strong>/)
  assert.match(html, /<ol>[\s\S]*<li>one<\/li>[\s\S]*<\/ol>/)
  assert.match(html, /<ul>[\s\S]*<li>a<\/li>[\s\S]*<\/ul>/)
})

test('display TeX ($$…$$) renders KaTeX markup', () => {
  const html = md.render('$$\\int \\frac{dx}{1+x^2} = \\arctan(x) + C$$')
  assert.match(html, /class="katex/)
  assert.ok(!html.includes('$$'), 'raw $$ delimiters must be consumed')
})

test('inline TeX ($…$) renders KaTeX markup', () => {
  const html = md.render('заменяем $x = \\tan(t)$ и считаем')
  assert.match(html, /class="katex/)
})

test('raw HTML in the source is escaped, not rendered', () => {
  const html = md.render('<script>alert(1)</script> и <b>жирный</b>')
  assert.ok(!html.includes('<script>'), 'script tag must not survive')
  assert.match(html, /&lt;script&gt;/)
  assert.ok(!html.includes('<b>'), 'raw b tag must not survive')
})

test('javascript: links are neutralized', () => {
  // markdown-it's link validator refuses the URL: no anchor is rendered at
  // all, the source stays visible as inert text.
  const html = md.render('[click](javascript:alert(1))')
  assert.ok(!html.includes('<a'), 'no anchor may be rendered for a javascript: URL')
})

test('http links render as anchors (click routing is the component job)', () => {
  const html = md.render('см. https://example.com/docs')
  assert.match(html, /<a href="https:\/\/example\.com\/docs">/)
})

test('a broken formula does not throw and does not kill the message', () => {
  let html = ''
  assert.doesNotThrow(() => {
    html = md.render('до\n\n$$\\frac{1}{$$\n\nпосле')
  })
  assert.match(html, /после/)
})
