import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir,readFile,rename,rmdir,symlink,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { provisionerBindingPinFixture } from "./provisioner-binding-pin-fixture.ts";

async function renameRoundTrip(path:string){await rename(path,path+"-released");await rename(path+"-released",path);}
it("provisioner pins core: exact retained directories and ancestors deny rename while child and metadata writes remain possible",{timeout:20000},async(t)=>{
  const f=await provisionerBindingPinFixture();t.after(f.cleanup);const pins=await f.hold();assert.equal(pins.state,"held");
  for(const path of [f.root,f.parent,f.repository,f.common])await assert.rejects(rename(path,path+"-renamed"));
  // Non-recursive removal of empty held leaves must also fail. No user paths.
  const control=join(f.root,"empty-deletion-control");await mkdir(control);await rmdir(control);
  await assert.rejects(rmdir(f.parent));await assert.rejects(rmdir(f.common));
  await mkdir(f.input.workspacePath);await writeFile(join(f.input.workspacePath,"allowed.txt"),"pinning is not write isolation\n");
  for(const name of ["config","packed-refs"]){await writeFile(join(f.common,name),"first\n");await writeFile(join(f.common,name),"changed\n");assert.equal(await readFile(join(f.common,name),"utf8"),"changed\n");}
  await pins.release();assert.equal(pins.child.exitCode,null);
  for(const path of [f.parent,f.common,f.repository,f.root])await renameRoundTrip(path);
  assert.equal(pins.child.exitCode,null,"release probes ran while the helper was still alive");
  const existingDirectory=await f.hold();assert.equal(existingDirectory.state,"held");await existingDirectory.kill();
  const existingFile=join(f.parent,"already-present.txt");await writeFile(existingFile,"not an absence reservation\n");
  const filePins=await f.hold({...f.input,workspacePath:existingFile});assert.equal(filePins.state,"held");await filePins.kill();
});
it("provisioner pins core: concurrent repeated disposal releases all pins while the helper remains alive",{timeout:20000},async(t)=>{
  const f=await provisionerBindingPinFixture();t.after(f.cleanup);const pins=await f.hold();assert.equal(pins.state,"held");
  await assert.rejects(rmdir(f.parent));await assert.rejects(rmdir(f.common));
  await pins.release(true);assert.equal(pins.child.exitCode,null);for(const path of [f.parent,f.common,f.repository,f.root])await renameRoundTrip(path);
  await rmdir(f.parent);await rmdir(f.common);assert.equal(pins.child.exitCode,null,"parallel Dispose, not process exit, released deletion exclusion");
});
it("provisioner pins core: holder death eventually releases namespace pins without claiming writer-stop ordering",{timeout:20000},async(t)=>{
  const f=await provisionerBindingPinFixture();t.after(f.cleanup);const pins=await f.hold();assert.equal(pins.state,"held");
  await pins.kill();for(const path of [f.parent,f.common,f.repository,f.root])await renameRoundTrip(path);
});
it("provisioner pins rejection: wrong machine and either wrong identity leave no partial handles in a live rejecting helper",{timeout:25000},async(t)=>{
  const f=await provisionerBindingPinFixture();t.after(f.cleanup);
  for(const field of ["machineFingerprint","parent","commonGitDirectory"] as const){
    const input=structuredClone(f.input);if(field==="machineFingerprint")input.machineFingerprint="0".repeat(64);else input[field].identity="win32-dir:00000000:0000000000000000";
    const pins=await f.hold(input);assert.equal(pins.state,"rejected");assert.equal(pins.child.exitCode,null);
    for(const path of [f.parent,f.common,f.repository,f.root])await renameRoundTrip(path);assert.equal(pins.child.exitCode,null);await pins.kill();
  }
});
it("provisioner pins rejection: missing, noncanonical and differently cased bindings cannot pin a substitute",{timeout:30000},async(t)=>{
  const f=await provisionerBindingPinFixture();t.after(f.cleanup);
  for(const field of ["parent","commonGitDirectory"] as const)for(const spelling of ["missing","dot","case"]){
    const input=structuredClone(f.input);input[field].path=spelling==="missing"?input[field].path+"-missing":spelling==="dot"?input[field].path+"\\.":input[field].path.toUpperCase();
    if(field==="parent" && spelling==="case")input.workspacePath=join(input.parent.path,"FutureCase");
    const pins=await f.hold(input);assert.equal(pins.state,"rejected");assert.equal(pins.child.exitCode,null);
    for(const path of [f.parent,f.common])await renameRoundTrip(path);assert.equal(pins.child.exitCode,null);await pins.kill();
  }
});
it("provisioner pins rejection: topology and reparse aliases cannot broaden the two retained bindings",{timeout:30000},async(t)=>{
  const f=await provisionerBindingPinFixture();t.after(f.cleanup);
  const alias=join(f.root,"junction"),commonAlias=join(f.root,"common-junction");await symlink(f.parent,alias,"junction");await symlink(f.common,commonAlias,"junction");
  const changes=[{workspacePath:join(f.root,"other")},{workspacePath:join(f.parent,"nested","target")},
    {parent:{...f.input.parent,path:alias},workspacePath:join(alias,"FutureCase")},
    {commonGitDirectory:{...f.input.commonGitDirectory,path:commonAlias}},
    {commonGitDirectory:{...f.input.parent}},{commonGitDirectory:{...f.input.commonGitDirectory,identity:f.input.parent.identity}},
    {parent:{...f.input.commonGitDirectory},workspacePath:join(f.common,"FutureCase")}];
  for(const change of changes){const pins=await f.hold({...structuredClone(f.input),...change});assert.equal(pins.state,"rejected");assert.equal(pins.child.exitCode,null);
    for(const path of [f.parent,f.common])await renameRoundTrip(path);assert.equal(pins.child.exitCode,null);await pins.kill();}
});
