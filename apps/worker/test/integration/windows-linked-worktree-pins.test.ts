import assert from "node:assert/strict";
import { it } from "node:test";
import { link, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { linkedPinFixture } from "./linked-worktree-pin-fixture.ts";

async function overwriteExact(path:string,contents:string|Uint8Array):Promise<void> {
  // r+ preserves Windows' hidden .git pointer attribute; unlike writeFile(r+),
  // truncation also removes bytes left by an earlier, longer test payload.
  const file=await open(path,"r+");
  try { await file.truncate(0); await file.writeFile(contents); }
  finally { await file.close(); }
}

it("linked identity pins retain exact directories and pointers while Git content stays mutable",{ timeout:25000 },async () => {
  const f=await linkedPinFixture(),pins=await f.hold();
  try {
    assert.equal(pins.state,"held");
    for(const target of [f.root,f.checkout,f.input.commonGitDirectory.path,f.workspace,f.input.gitDirectory.path]) {
      await assert.rejects(rename(target,target+"-renamed"));
    }
    for(const target of [join(f.workspace,".git"),join(f.input.gitDirectory.path,"gitdir"),join(f.input.gitDirectory.path,"commondir")]) {
      await assert.rejects(rename(target,target+"-renamed"));
      await assert.rejects(writeFile(target,await readFile(target),{ flag:"r+" }));
    }
    await writeFile(join(f.workspace,"allowed.txt"),"ordinary worktree content\n");
    await f.git(f.workspace,"add","allowed.txt");
    await f.git(f.workspace,"-c","user.name=ACP synthetic test","-c","user.email=acp@example.invalid","commit","-m","Content allowed under identity pins");
    assert.equal(await f.git(f.workspace,"status","--porcelain"),"");
    await pins.release();
    await rename(f.workspace,f.workspace+"-renamed"); await rename(f.workspace+"-renamed",f.workspace);
    const pointer=join(f.input.gitDirectory.path,"gitdir"); await writeFile(pointer,await readFile(pointer),{ flag:"r+" });
  } finally { await pins.kill(); await f.dispose(); }
});

it("linked pin identity rejection releases every earlier handle while the rejecting helper stays alive",{ timeout:25000 },async () => {
  const f=await linkedPinFixture();
  try {
    for(const field of ["machineFingerprint","checkout","commonGitDirectory","workspace","gitDirectory"] as const) {
      const input=structuredClone(f.input);
      if(field==="machineFingerprint") input.machineFingerprint="0".repeat(64);
      else input[field]={ ...input[field],identity:"win32-dir:00000000:0000000000000000" };
      const pins=await f.hold(input);
      try {
        assert.equal(pins.state,"rejected",field); assert.equal(pins.child.exitCode,null);
        for(const binding of [f.input.checkout,f.input.commonGitDirectory,f.input.workspace,f.input.gitDirectory]) {
          await rename(binding.path,binding.path+"-released"); await rename(binding.path+"-released",binding.path);
        }
        const pointer=join(f.workspace,".git"); await writeFile(pointer,await readFile(pointer),{ flag:"r+" });
      } finally { await pins.release(); }
    }
  } finally { await f.dispose(); }
});

it("linked pins reject altered structural pointers and hardlinks without retaining partial ownership",{ timeout:25000 },async () => {
  const f=await linkedPinFixture();
  try {
    const pointers=[join(f.workspace,".git"),join(f.input.gitDirectory.path,"gitdir"),join(f.input.gitDirectory.path,"commondir")];
    for(const pointer of pointers) {
      const before=await readFile(pointer);
      await overwriteExact(pointer,"invalid structural pointer\n");
      const pins=await f.hold();
      try {
        assert.equal(pins.state,"rejected"); assert.equal(pins.child.exitCode,null);
        // Restore while the rejecting helper lives; an internal leaked file pin
        // would make this fail even though process-exit cleanup could hide it.
        await overwriteExact(pointer,before);
        assert.deepEqual(await readFile(pointer),before);
        for(const released of pointers) await writeFile(released,await readFile(released),{ flag:"r+" });
      } finally { await pins.release(); }
    }
    for(const pointer of pointers) {
      const copy=join(f.root,"hardlinked-pointer"); await link(pointer,copy);
      const pins=await f.hold();
      try {
        assert.equal(pins.state,"rejected"); assert.equal(pins.child.exitCode,null);
        await rm(copy);
        for(const released of pointers) await writeFile(released,await readFile(released),{ flag:"r+" });
      } finally { await pins.release(); }
    }
    const healthy=await f.hold();
    try { assert.equal(healthy.state,"held"); } finally { await healthy.release(); }
  } finally { await f.dispose(); }
});

it("linked pins reject pre-existing structural-pointer writers and noncanonical retained paths",{ timeout:25000 },async () => {
  const f=await linkedPinFixture();
  try {
    for(const pointer of [join(f.workspace,".git"),join(f.input.gitDirectory.path,"gitdir"),join(f.input.gitDirectory.path,"commondir")]) {
      const writer=await open(pointer,"r+");
      try {
        const pins=await f.hold();
        try { assert.equal(pins.state,"rejected"); assert.equal(pins.child.exitCode,null); }
        finally { await pins.release(); }
      } finally { await writer.close(); }
    }
    for(const field of ["checkout","commonGitDirectory","workspace","gitDirectory"] as const) {
      const input=structuredClone(f.input); input[field]={ ...input[field],path:input[field].path+"\\." };
      const pins=await f.hold(input);
      try { assert.equal(pins.state,"rejected"); assert.equal(pins.child.exitCode,null); }
      finally { await pins.release(); }
    }
    const healthy=await f.hold();
    try { assert.equal(healthy.state,"held"); } finally { await healthy.release(); }
  } finally { await f.dispose(); }
});

it("linked pin helper death releases handles but does not claim writer-stop ordering or reserve absent metadata",{ timeout:25000 },async () => {
  const f=await linkedPinFixture(),pins=await f.hold();
  try {
    assert.equal(pins.state,"held");
    // Intentional non-guarantee: the identity scope does not reserve absence or
    // freeze configuration. Delivery must add a restricted-access boundary.
    await writeFile(join(f.input.gitDirectory.path,"config.worktree"),"[core]\n\tbare = false\n");
    await writeFile(join(f.input.commonGitDirectory.path,"objects","info","alternates"),"untrusted-path\n");
    await pins.kill();
    for(const binding of [f.input.checkout,f.input.commonGitDirectory,f.input.workspace,f.input.gitDirectory]) {
      await rename(binding.path,binding.path+"-released"); await rename(binding.path+"-released",binding.path);
    }
    for(const pointer of [join(f.workspace,".git"),join(f.input.gitDirectory.path,"gitdir"),join(f.input.gitDirectory.path,"commondir")]) {
      await writeFile(pointer,await readFile(pointer),{ flag:"r+" });
    }
  } finally { await pins.kill(); await f.dispose(); }
});
