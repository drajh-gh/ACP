import assert from "node:assert/strict";
import { it } from "node:test";
import { parseBoundedJson } from "../src/bounded-json.ts";

const native={maximumBytes:65536,maximumDepth:12,maximumNodes:1000,canonicalIntegers:true};
it("bounded JSON preserves Unicode, quoted tokens and separate-object keys",()=>{
  assert.deepEqual(parseBoundedJson('{"text":"ž 🚀 1.0 \\\"","a":{"x":1},"b":{"x":2}}',native),{text:'ž 🚀 1.0 "',a:{x:1},b:{x:2}});
});
it("bounded JSON rejects duplicate decoded keys at every depth",()=>{
  for(const text of ['{"x":1,"x":1}','{"x":1,"\\u0078":1}','{"a":[{"x":1,"x":2}]}'])assert.throws(()=>parseBoundedJson(text,native),/duplicate/u);
});
it("native JSON rejects numeric aliases before JavaScript rounding",()=>{
  for(const token of ["1.0","1e0","1.0000000000000000001","9007199254740993","1e400","-0"])
    assert.throws(()=>parseBoundedJson(`{"number":${token}}`,native),/integer/u,token);
  assert.deepEqual(parseBoundedJson('{"pid":2147483647,"exit":-2147483648,"zero":0}',native),{pid:2147483647,exit:-2147483648,zero:0});
});
it("manifest mode retains ordinary decimal and exponent JSON semantics",()=>{
  assert.deepEqual(parseBoundedJson('{"n":1.5,"e":1e2}',{...native,canonicalIntegers:false}),{n:1.5,e:100});
});
it("bounded JSON rejects malformed grammar, escapes, BOM and trailing content",()=>{
  for(const text of ['{"x":1,}','{"x":"\\q"}','{"x":1}{}','\ufeff{}','{"x":','[}', '{"x":01}'])assert.throws(()=>parseBoundedJson(text,native));
});
it("bounded JSON enforces byte, depth, node and configuration limits",()=>{
  assert.throws(()=>parseBoundedJson('"🚀"',{...native,maximumBytes:5}),/byte/u);
  assert.throws(()=>parseBoundedJson('[[[]]]',{...native,maximumDepth:2}),/depth/u);
  assert.throws(()=>parseBoundedJson('[1,2]',{...native,maximumNodes:2}),/node/u);
  for(const change of [{maximumBytes:0},{maximumBytes:524289},{maximumDepth:33},{maximumNodes:10001},{maximumDepth:1.5},{canonicalIntegers:1}])
    assert.throws(()=>parseBoundedJson('{}',{...native,...change} as never),/bounds/u);
});
