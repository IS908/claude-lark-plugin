import { OpenVikingMemoryProvider } from '../src/memory/openviking.js';

async function test() {
  const ov = new OpenVikingMemoryProvider('http://localhost:1933');

  const healthy = await ov.healthCheck();
  console.error('Health check:', healthy ? 'OK' : 'UNREACHABLE');
  if (!healthy) { console.error('OpenViking not running — skip'); return; }

  const testChat = `test-chat-${Date.now()}`;

  // Test profile
  await ov.saveProfile('test-user', '# Test User\nPrefers concise answers.');
  const profile = await ov.getProfile('test-user');
  console.error('Profile save/load:', profile?.includes('concise') ? 'OK' : 'FAIL');

  // Test episode save + search
  await ov.saveEpisode('chat', '# Deployment Discussion\nWe discussed the new CI/CD pipeline for production. The team agreed to use blue-green deployment strategy with automated rollback. Canary at 5%, full rollout after 30min.', { chatId: testChat });
  console.error('Episode saved, waiting for indexing...');

  // Wait for OpenViking to index (embedding takes a few seconds)
  await new Promise(r => setTimeout(r, 4000));

  // Search for the episode
  const episodes = await ov.searchEpisodes('deployment pipeline rollback', { chatId: testChat });
  console.error('Episode search:', episodes.length > 0 ? `OK (${episodes.length} results, score: ${episodes[0]?.score?.toFixed(3)})` : 'EMPTY');
  if (episodes.length > 0) {
    const preview = episodes[0].content.substring(0, 80);
    console.error('  Content:', preview + (episodes[0].content.length > 80 ? '...' : ''));
  }

  // Test cross-chat isolation
  const otherChat = await ov.searchEpisodes('deployment', { chatId: 'nonexistent-chat-xyz' });
  console.error('Cross-chat isolation:', otherChat.length === 0 ? 'OK (no leakage)' : `FAIL (leaked ${otherChat.length} results)`);

  // Test skill save + search
  await ov.saveSkill('deploy-prod', 'Production deployment procedure', '1. Build image\n2. Push to registry\n3. Canary 5%\n4. Full rollout');
  console.error('Skill saved, waiting for indexing...');
  await new Promise(r => setTimeout(r, 4000));

  const skills = await ov.searchSkills('how to deploy production');
  console.error('Skill search:', skills.length > 0 ? `OK (${skills.length} results, score: ${skills[0]?.score?.toFixed(3)})` : 'EMPTY');
  if (skills.length > 0) {
    console.error('  Name:', skills[0].name);
  }

  console.error('\n✅ All OpenViking integration tests complete!');
}

test().catch(console.error);
