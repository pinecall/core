import { Pinecall } from '@pinecall/sdk';
import http from 'http';

const pc = new Pinecall({ apiKey: 'test' });
const agent = pc.agent('test', {});

// Test 1: agent.stream() — Web Response mode
try {
  const res = agent.stream();
  console.log('✅ agent.stream() → Response OK:', typeof res, res.constructor?.name);
} catch (e) {
  console.error('❌ agent.stream() ERROR:', e.message);
  console.error(e.stack);
}

// Test 2: pc.stream() — Web Response mode
try {
  const res = pc.stream();
  console.log('✅ pc.stream() → Response OK:', typeof res, res.constructor?.name);
} catch (e) {
  console.error('❌ pc.stream() ERROR:', e.message);
  console.error(e.stack);
}

// Test 3: agent.stream(res) — Node ServerResponse mode
const server = http.createServer((req, res) => {
  try {
    agent.stream(res);
    console.log('✅ agent.stream(res) — Node mode OK');
  } catch (e) {
    console.error('❌ agent.stream(res) ERROR:', e.message);
    console.error(e.stack);
    res.writeHead(500);
    res.end(e.message);
  }
});

server.listen(0, () => {
  const port = server.address().port;
  http.get(`http://localhost:${port}`, (res) => {
    console.log('  HTTP status:', res.statusCode);
    res.on('data', (chunk) => {
      console.log('  First chunk:', chunk.toString().trim());
      server.close();
      process.exit(0);
    });
  });
});
