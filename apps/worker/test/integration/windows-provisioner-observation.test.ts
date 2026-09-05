import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, writeFile, readFile, rename, rm, rmdir, symlink, link, open } from "node:fs/promises";
import { join } from "node:path";
import { observeWindowsProvisionerTarget } from "../../src/windows-repository-observer.ts";
import { provisionerFixture, metadataSnapshot } from "./provisioner-observation-fixture.ts";

const native=process.platform==="win32",settings={ skip:!native,timeout:30000 },unconfirmed={ state:"unconfirmed" };
it("preflight core: native Unicode parent, exact branch and SHA1 base are read-only and released",settings,async()=>{
  const f=await provisionerFixture();
  try {
    const before=await metadataSnapshot(f.repository.commonGitDirectory.path),result=await f.observe();
    assert.equal(result.state,"observed"); if(result.state!=="observed") throw new Error("target unavailable");
    assert.equal(result.parent.path,f.parent); assert.match(result.parent.identity,/^win32-dir:/u);
    assert.equal(result.branchRef,f.input.branchRef); assert.equal(result.baseRevision,f.input.baseRevision); assert.equal(result.scope,"observation_only");
    assert.deepEqual(await metadataSnapshot(f.repository.commonGitDirectory.path),before);
    await assert.rejects(readFile(f.input.workspacePath),{ code:"ENOENT" });
    await rename(f.parent,f.parent+"-moved"); await mkdir(f.parent); // No retained pin or absence reservation.
    await mkdir(f.input.workspacePath); assert.deepEqual(await f.observe(),unconfirmed);
  } finally { await f.dispose(); }
});
it("preflight core: SHA256 requires the full commit, not a valid 40-character abbreviation",settings,async()=>{
  const f=await provisionerFixture("sha256");
  try {
    assert.equal(f.input.baseRevision.length,64); assert.equal((await f.observe()).state,"observed");
    assert.deepEqual(await f.observe({ baseRevision:f.input.baseRevision.slice(0,40) }),unconfirmed);
  } finally { await f.dispose(); }
});
it("preflight core: exact base rejects tree, annotated tag and missing commit objects",settings,async()=>{
  const f=await provisionerFixture();
  try {
    const tree=await f.git(f.checkout,"rev-parse","HEAD^{tree}");
    await f.git(f.checkout,"-c","user.name=ACP test","-c","user.email=acp@example.invalid","tag","-a","annotated","-m","Fixture tag");
    const tag=await f.git(f.checkout,"rev-parse","refs/tags/annotated");
    for(const baseRevision of [tree,tag,"0".repeat(40)]) assert.deepEqual(await f.observe({ baseRevision }),unconfirmed);
  } finally { await f.dispose(); }
});
it("preflight paths: existing objects, missing parent and junction aliases are not absence",settings,async()=>{
  const f=await provisionerFixture();
  try {
    await writeFile(f.input.workspacePath,"existing"); assert.deepEqual(await f.observe(),unconfirmed); await rm(f.input.workspacePath);
    await symlink(f.checkout,f.input.workspacePath,"junction"); assert.deepEqual(await f.observe(),unconfirmed); await rm(f.input.workspacePath);
    const absentParent=join(f.root,"missing","target"); assert.deepEqual(await f.observe({ workspacePath:absentParent }),unconfirmed);
    const alias=join(f.root,"alias"); await symlink(f.parent,alias,"junction");
    assert.deepEqual(await f.observe({ workspacePath:join(alias,"target") }),unconfirmed); await rm(alias);
    assert.deepEqual(await f.observe({ workspacePath:join(f.parent.toUpperCase(),"target") }),unconfirmed);
  } finally { await f.dispose(); }
});
it("preflight paths: wrong machine, replaced identity and repository-overlapping target are denied",settings,async()=>{
  const f=await provisionerFixture();
  try {
    assert.deepEqual(await observeWindowsProvisionerTarget({ ...f.repository,machineFingerprint:"0".repeat(64) },f.input,f.signal(),f.options),unconfirmed);
    assert.deepEqual(await observeWindowsProvisionerTarget({ ...f.repository,checkout:{ ...f.repository.checkout,identity:"win32-dir:00000000:0000000000000000" } },f.input,f.signal(),f.options),unconfirmed);
    assert.deepEqual(await f.observe({ workspacePath:join(f.checkout,"target") }),unconfirmed);
    await rename(f.checkout,f.checkout+"-old"); await mkdir(f.checkout); assert.deepEqual(await f.observe(),unconfirmed);
  } finally { await f.dispose(); }
});
it("preflight branches: loose and packed exact, prefix and component-case conflicts are denied",settings,async()=>{
  const f=await provisionerFixture();
  try {
    await f.git(f.checkout,"branch","Feature/Existing");
    for(const branchRef of ["refs/heads/Feature/Existing","refs/heads/Feature","refs/heads/Feature/Existing/Child","refs/heads/feature/Different"])
      assert.deepEqual(await f.observe({ branchRef }),unconfirmed);
    assert.equal((await f.observe()).state,"observed");
    await f.git(f.checkout,"pack-refs","--all","--prune");
    assert.deepEqual(await f.observe({ branchRef:"refs/heads/feature/Different" }),unconfirmed);
    assert.deepEqual(await f.observe({ branchRef:"refs/heads/Feature/Existing" }),unconfirmed);
    assert.equal((await f.observe()).state,"observed");
  } finally { await f.dispose(); }
});
it("preflight branches: dangling refs, loose empty namespace and malformed inventory warnings fail closed",settings,async()=>{
  const f=await provisionerFixture();
  try {
    const heads=join(f.repository.commonGitDirectory.path,"refs","heads");
    await mkdir(join(heads,"Feature")); await writeFile(join(heads,"Feature","ExactCase"),"ref: refs/heads/absent\n");
    assert.deepEqual(await f.observe(),unconfirmed); await rm(join(heads,"Feature","ExactCase"));
    assert.deepEqual(await f.observe({ branchRef:"refs/heads/feature/New" }),unconfirmed);
    await mkdir(join(heads,"Feature","ExactCase")); assert.deepEqual(await f.observe(),unconfirmed); await rmdir(join(heads,"Feature","ExactCase"));
    await writeFile(join(heads,"Feature","ExactCase"),f.input.baseRevision+"\n");
    assert.deepEqual(await f.observe({ branchRef:"refs/heads/Feature/ExactCase/Child" }),unconfirmed); await rm(join(heads,"Feature","ExactCase"));
    await writeFile(join(heads,"Broken"),"not-a-ref\n"); assert.deepEqual(await f.observe(),unconfirmed);
  } finally { await f.dispose(); }
});
it("preflight metadata: packed refs must be bounded single-link regular metadata",settings,async()=>{
  const f=await provisionerFixture();
  try {
    await f.git(f.checkout,"pack-refs","--all","--prune"); const packed=join(f.repository.commonGitDirectory.path,"packed-refs"),copy=join(f.root,"packed-copy");
    await link(packed,copy); assert.deepEqual(await f.observe(),unconfirmed); await rm(copy);
    const original=await readFile(packed); await writeFile(packed,"#".repeat(16385)); assert.deepEqual(await f.observe(),unconfirmed);
    await writeFile(packed,original); assert.equal((await f.observe()).state,"observed");
    await rm(packed); const redirected=join(f.root,"redirected-metadata"); await mkdir(redirected);
    await symlink(redirected,packed,"junction"); assert.deepEqual(await f.observe(),unconfirmed); await rm(packed);
  } finally { await f.dispose(); }
});
it("preflight limits: UTF8 head inventory overflow fails closed and stops owned processes",settings,async()=>{
  const f=await provisionerFixture();
  try {
    const heads=join(f.repository.commonGitDirectory.path,"refs","heads");
    for(let i=0;i<190;i++) await writeFile(join(heads,"branch"+String(i).padStart(3,"0")+"ž".repeat(40)),f.input.baseRevision+"\n");
    let children=0;
    assert.deepEqual(await observeWindowsProvisionerTarget(f.repository,f.input,f.signal(),{ ...f.options,onSpawn:(pid,purpose)=>{
      f.options.onSpawn(pid,purpose); if(purpose.includes("Git child")) children++;
    } }),unconfirmed);
    assert.equal(children,3,"failure must occur in bounded enumeration, not earlier native/config checks");
  } finally { await f.dispose(); }
});
it("preflight limits: 200 heads are bounded and a 201st is never silently omitted",settings,async()=>{
  const f=await provisionerFixture();
  try {
    const heads=join(f.repository.commonGitDirectory.path,"refs","heads");
    for(let i=0;i<199;i++) await writeFile(join(heads,"branch"+String(i).padStart(3,"0")),f.input.baseRevision+"\n");
    assert.equal((await f.observe()).state,"observed");
    await writeFile(join(heads,"branch199"),f.input.baseRevision+"\n"); assert.deepEqual(await f.observe(),unconfirmed);
  } finally { await f.dispose(); }
});
it("preflight races: final branch and target checks reject changes after the first enumeration",settings,async()=>{
  for(const action of ["target","branch","packed"] as const) {
    const f=await provisionerFixture();
    try { const result=await f.probe(action); assert.equal(result.applied,true); assert.deepEqual(result.observation,unconfirmed); }
    finally { await f.dispose(); }
  }
});
it("preflight races: parent and packed metadata pins deny mutation only until return",settings,async()=>{
  const f=await provisionerFixture();
  try {
    await f.git(f.checkout,"pack-refs","--all","--prune"); const result=await f.probe("pins");
    assert.equal(result.applied,true); assert.equal(result.pinsDenied,true); assert.equal(result.observation.state,"observed");
    await rename(f.parent,f.parent+"-moved"); const released=await open(join(f.repository.commonGitDirectory.path,"packed-refs"),"r+"); await released.close();
  } finally { await f.dispose(); }
});
it("preflight races: empty directory and ancestor pins reject prior delete handles without reserving child names",settings,async()=>{
  const f=await provisionerFixture();
  try { const result=await f.probe("directory-pins"); assert.equal(result.applied,true); assert.equal(result.pinsDenied,true); }
  finally { await f.dispose(); }
});
it("preflight cancellation: abort during owned Git exits without an observation or leaked processes",settings,async()=>{
  const f=await provisionerFixture();
  try {
    const controller=new AbortController();
    assert.deepEqual(await observeWindowsProvisionerTarget(f.repository,f.input,controller.signal,{ ...f.options,onSpawn:(pid,purpose)=>{
      f.options.onSpawn(pid,purpose); if(purpose.includes("Git child")) controller.abort();
    } }),unconfirmed); assert.equal(controller.signal.aborted,true);
  } finally { await f.dispose(); }
});
