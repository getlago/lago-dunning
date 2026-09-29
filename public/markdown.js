const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const inline=text=>escape(text).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/`([^`]+)`/g,'<code>$1</code>');

// GitHub-style pipe tables: a header row, a |---|:--:|---:| separator, then body rows.
const isRow=line=>/^\s*\|.*\|\s*$/.test(line);
const isSeparator=line=>/^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line);
const cells=line=>{const t=line.trim().replace(/^\|/,'').replace(/\|$/,'');const out=[];let cur='';for(let i=0;i<t.length;i++){if(t[i]==='\\'&&t[i+1]==='|'){cur+='|';i++;}else if(t[i]==='|'){out.push(cur.trim());cur='';}else cur+=t[i];}out.push(cur.trim());return out;};
const table=(lines,start)=>{
  const header=cells(lines[start]),aligns=cells(lines[start+1]).map(c=>/^:-+:$/.test(c)?'center':/^-+:$/.test(c)?'right':'');
  let end=start+2;const body=[];
  while(end<lines.length&&isRow(lines[end])){body.push(cells(lines[end]));end++;}
  const cell=(tag,text,i)=>`<${tag}${aligns[i]?` style="text-align:${aligns[i]}"`:''}>${inline(text??'')}</${tag}>`;
  const row=(tag,values)=>'<tr>'+header.map((_,i)=>cell(tag,values[i],i)).join('')+'</tr>';
  return {end,html:`<div class="table-scroll"><table><thead>${row('th',header)}</thead><tbody>${body.map(r=>row('td',r)).join('')}</tbody></table></div>`};
};

// Keep each parent <li> open until its child lists have closed.
export function markdown(value){
  let html='',paragraph=[];
  const lists=[];
  const flush=()=>{if(paragraph.length){html+='<p>'+paragraph.map(inline).join('<br>')+'</p>';paragraph=[];}};
  const closeList=()=>{const list=lists.pop();html+=`</li></${list.type}>`;};
  const closeLists=()=>{while(lists.length)closeList();};
  const lines=String(value).split('\n').map(raw=>raw.replace(/\t/g,'    '));
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(isRow(line)&&i+1<lines.length&&isSeparator(lines[i+1])){flush();closeLists();const t=table(lines,i);html+=t.html;i=t.end-1;continue;}
    const item=/^(\s*)(?:([-*+])|(\d+)[.)])\s+(.+)$/.exec(line);
    if(item){
      flush();
      const indent=item[1].length,type=item[2]?'ul':'ol';
      while(lists.length&&lists.at(-1).indent>indent)closeList();
      if(lists.length&&lists.at(-1).indent===indent&&lists.at(-1).type!==type)closeList();
      if(!lists.length||lists.at(-1).indent<indent){
        html+=type==='ol'?`<ol start="${Number(item[3])}">`:'<ul>';
        lists.push({indent,type});
      }else html+='</li>';
      html+=`<li>${inline(item[4])}`;
      continue;
    }
    if(!line.trim()){flush();continue;}
    const heading=/^#{1,6}\s+(.+)$/.exec(line),rule=/^---+$/.test(line.trim());
    if(lists.length&&!heading&&!rule&&/^\s*/.exec(line)[0].length>lists.at(-1).indent){
      html+='<br>'+inline(line.trim());continue;
    }
    closeLists();
    if(heading){flush();html+=`<h3>${inline(heading[1])}</h3>`;}
    else if(rule){flush();html+='<hr>';}
    else paragraph.push(line);
  }
  flush();closeLists();return html;
}
