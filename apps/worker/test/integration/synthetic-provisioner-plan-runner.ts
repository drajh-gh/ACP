// Fixed model-free capsule: report the private derived input, never execute it.
let input="";for await(const chunk of process.stdin)input+=String(chunk);
process.stdout.write(JSON.stringify({processId:process.pid,workspace:process.cwd(),plan:JSON.parse(input) as unknown,
  leaked:Object.keys(process.env).some(key=>/^(?:ACP_|OPENAI_|PGPASSWORD|DATABASE_URL)/u.test(key))}));
