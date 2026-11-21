export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function until(ms, now = Date.now()) {
  const m = Math.round((ms - now) / 60000);
  if (m <= 0) return 'now';
  if (m < 60) return `in ${m} min`;
  return `in ${Math.floor(m / 60)} h ${m % 60} min`;
}

const CODES = {
  PATH_COLLISION: 'path collision',
  ISSUE_LEASED: 'already leased',
  HUMAN_WORKING: 'a person is working on it',
  PROTECTED_PATH: 'protected path',
  NOT_AGENT_READY: 'not marked safe for agents',
  AGENT_BUSY: 'agent at its lease limit',
  TOO_BROAD: 'claim too broad',
};

export function eventLine(e) {
  const who = e.agent || 'an agent';
  switch (e.type) {
    case 'granted':
      return `${who}${e.owner ? ` (for ${e.owner})` : ''} got the lease`;
    case 'renewed':
      return `${who} re-claimed its lease`;
    case 'denied':
      return `${who} was refused: ${CODES[e.code] || e.code}${e.blockedBy?.length ? ` (${e.blockedBy.join(', ')})` : ''}`;
    case 'released':
      return `${who} released it: ${e.outcome}${e.prUrl ? ' — PR linked' : ''}`;
    case 'expired':
      return `${who} went silent; lease expired and work returned to the queue`;
    case 'revoked':
      return `${e.by || 'A person'} took it back from ${who}`;
    case 'human-overlap':
      return `${e.owner || 'A person'} started it while ${who} held the lease`;
    default:
      return e.type;
  }
}
