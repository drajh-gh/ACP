export interface BoundedJsonLimits {
  readonly maximumBytes:number;
  readonly maximumDepth:number;
  readonly maximumNodes:number;
  readonly canonicalIntegers?:boolean;
}

/** Shared duplicate-decoded-key scanner; JSON.parse still validates full grammar. */
export function parseBoundedJson(text:string,limits:BoundedJsonLimits):unknown {
  const {maximumBytes,maximumDepth,maximumNodes}=limits;
  if(!Number.isSafeInteger(maximumBytes) || maximumBytes<1 || maximumBytes>524288
    || !Number.isSafeInteger(maximumDepth) || maximumDepth<1 || maximumDepth>32
    || !Number.isSafeInteger(maximumNodes) || maximumNodes<1 || maximumNodes>10000
    || (limits.canonicalIntegers!==undefined && typeof limits.canonicalIntegers!=="boolean"))throw new TypeError("invalid JSON bounds");
  if(typeof text!=="string" || text.length>maximumBytes || Buffer.byteLength(text,"utf8")>maximumBytes)throw new Error("JSON byte bound");
  const stack:{object:boolean;keys:Set<string>;expectsKey:boolean}[]=[];
  let index=0;
  while(index<text.length) {
    const char=text[index]!;
    if(char==='"') {
      const start=index++;let closed=false;
      while(index<text.length) {
        if(text[index]==="\\"){index+=2;continue;}
        if(text[index++]==='"'){closed=true;break;}
      }
      if(!closed)throw new Error("unterminated JSON string");
      const parent=stack.at(-1);
      if(parent?.object && parent.expectsKey) {
        const key=JSON.parse(text.slice(start,index)) as string;
        if(parent.keys.has(key))throw new Error("duplicate JSON key");
        parent.keys.add(key);parent.expectsKey=false;
      }
    } else if(limits.canonicalIntegers && (char==="-" || /[0-9]/u.test(char))) {
      const token=/^-?(?:0|[1-9][0-9]*)(?=[\x20\t\r\n,\]}]|$)/u.exec(text.slice(index))?.[0];
      if(!token || !Number.isSafeInteger(Number(token)) || String(Number(token))!==token)throw new Error("canonical safe JSON integer required");
      index+=token.length;
    } else {
      if(char==="{" || char==="[") {
        stack.push({object:char==="{",keys:new Set(),expectsKey:char==="{"});
        if(stack.length>maximumDepth)throw new Error("JSON depth bound");
      } else if(char==="}" || char==="]")stack.pop();
      else if(char==="," && stack.at(-1)?.object)stack.at(-1)!.expectsKey=true;
      index++;
    }
  }
  const root=JSON.parse(text) as unknown,pending:unknown[]=[root];let nodes=0;
  while(pending.length) {
    const item=pending.pop();if(++nodes>maximumNodes)throw new Error("JSON node bound");
    if(Array.isArray(item))pending.push(...item);
    else if(item!==null && typeof item==="object")pending.push(...Object.values(item));
  }
  return root;
}
