import test from 'node:test';
import assert from 'node:assert/strict';
import {emailBodyHtml,emailDocumentHtml} from '../public/email-format.js';
test('email HTML preserves paragraphs and uses readable invoice and portal links',()=>{
 const text='Hi Chronicle,\r\n\r\nINV-1 · €2,800.00\r\nView invoice: https://api.lago.dev/invoices/one.pdf?x=1&y=2\r\n\r\nPlease update your payment method here:\r\nhttps://billing.example/update\r\n\r\nThanks,\r\nAccounts Receivable';
 const html=emailBodyHtml(text);
 assert.equal((html.match(/<p>/g)??[]).length,4);
 assert(html.includes('INV-1 · €2,800.00<br>View invoice: '));
 assert(html.includes('href="https://api.lago.dev/invoices/one.pdf?x=1&amp;y=2"'));
 assert(html.includes('>Open PDF</a>'));assert(html.includes('>Open billing portal</a>'));
 assert(html.includes('Thanks,<br>Accounts Receivable'));
 assert(emailDocumentHtml(text).includes(emailBodyHtml(text,{inlineStyles:true})));
});
test('email HTML escapes content and does not turn credential-bearing URLs or unsafe schemes into links',()=>{
 const html=emailBodyHtml('<img src=x onerror="bad()">\n\nView invoice: javascript:alert(1)\nhttps://user:secret@example.com/private');
 assert(!html.includes('<img'));assert(!html.includes('<a '));assert(html.includes('&lt;img'));
 const quoted=emailBodyHtml('View invoice: https://example.com/a"onclick="bad');
 assert(!quoted.includes('"onclick="'));assert(quoted.includes('>Open PDF</a>'));
});
