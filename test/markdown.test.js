import test from 'node:test';
import assert from 'node:assert/strict';
import {markdown} from '../public/markdown.js';

test('status cases are nested inside Review rather than beside the status groups',()=>{
 const result=markdown('**Summary by status:**\n- **Held**: €44,750.00\n- **Review**: €16,650.00\n  - **High Balance Review**: €15,000.00\n  - **Escalation Test**: €1,650.00\n\n**Key notes:**\n- Paused customers');
 assert.equal(result,'<p><strong>Summary by status:</strong></p><ul><li><strong>Held</strong>: €44,750.00</li><li><strong>Review</strong>: €16,650.00<ul><li><strong>High Balance Review</strong>: €15,000.00</li><li><strong>Escalation Test</strong>: €1,650.00</li></ul></li></ul><p><strong>Key notes:</strong></p><ul><li>Paused customers</li></ul>');
});
test('nested ordered and unordered lists close before siblings and following paragraphs',()=>{
 assert.equal(markdown('3. Parent\n   - Child\n     1. Grandchild\n   - Other child\n4. Next\n\nDone.'),'<ol start="3"><li>Parent<ul><li>Child<ol start="1"><li>Grandchild</li></ol></li><li>Other child</li></ul></li><li>Next</li></ol><p>Done.</p>');
});
test('blank lines, indented continuations and list-type changes preserve valid structure',()=>{
 assert.equal(markdown('- Parent\n\n  - Child\n    More detail\n\n  2. Step\n- Next'),'<ul><li>Parent<ul><li>Child<br>More detail</li></ul><ol start="2"><li>Step</li></ol></li><li>Next</li></ul>');
});
test('nested chat content remains escaped and ordinary formatting still works',()=>{
 const html=markdown('### Heading\nText **bold** and `code`.\n\n- <img src=x onerror=alert(1)>\n  - <script>bad()</script>\n\n---');
 assert(!html.includes('<img'));assert(!html.includes('<script>'));
 assert(html.includes('&lt;script&gt;'));assert(html.startsWith('<h3>Heading</h3><p>Text <strong>bold</strong> and <code>code</code>.</p>'));
 assert(html.endsWith('</li></ul></li></ul><hr>'));
});
test('pipe tables render as tables with escaped cells and alignment, and text resumes after them',()=>{
 const html=markdown('Key customers:\n| Customer | Balance | Note |\n|----------|-------:|------|\n| Acme | €6,250.00 | **Firm** tone |\n| <b>x</b> | 1 \\| 2 |\nDone.');
 assert.equal(html,'<p>Key customers:</p><div class="table-scroll"><table><thead><tr><th>Customer</th><th style="text-align:right">Balance</th><th>Note</th></tr></thead><tbody><tr><td>Acme</td><td style="text-align:right">€6,250.00</td><td><strong>Firm</strong> tone</td></tr><tr><td>&lt;b&gt;x&lt;/b&gt;</td><td style="text-align:right">1 | 2</td><td></td></tr></tbody></table></div><p>Done.</p>');
 assert.equal(markdown('| not | a table |\nplain'),'<p>| not | a table |<br>plain</p>');
});
