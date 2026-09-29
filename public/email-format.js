// One escaped renderer for the approval preview and the HTML email alternative.
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function inline(text,inlineStyles){
  const parts=text.split(/(https?:\/\/[^\s<>]+)/g);
  return parts.map((part,index)=>{
    if(index%2===0)return escape(part).replace(/\n/g,'<br>');
    try{
      const url=new URL(part);
      if(url.username||url.password||!['https:','http:'].includes(url.protocol))return escape(part);
      const before=parts[index-1]??'';
      const label=before.endsWith('View invoice: ')?'Open PDF':/Please update your payment method here:\s*$/.test(before)?'Open billing portal':part;
      return `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer" ${inlineStyles?'style="color:#6656c9;text-decoration:underline;overflow-wrap:anywhere"':''}>${escape(label)}</a>`;
    }catch{return escape(part);}
  }).join('');
}
export function emailBodyHtml(text,{inlineStyles=false}={}){
  return String(text??'').replace(/\r\n?/g,'\n').split(/\n[\t ]*\n/).map(paragraph=>`<p${inlineStyles?' style="margin:0 0 16px;line-height:1.7"':''}>${inline(paragraph,inlineStyles)}</p>`).join('');
}
export function emailDocumentHtml(text){
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:24px;background:#ffffff;color:#25272a;font-family:Arial,Helvetica,sans-serif;font-size:14px"><div style="max-width:640px">${emailBodyHtml(text,{inlineStyles:true})}</div></body></html>`;
}
