export function archiveReplayHost(archiveId) {
  const match = /^archive_([a-z0-9]+)_([a-z0-9]+)$/i.exec(String(archiveId || ''));
  return match ? `a-${match[1].toLowerCase()}-${match[2].toLowerCase()}.localhost` : null;
}

export function archiveIdFromReplayHost(hostname) {
  const match = /^a-([a-z0-9]+)-([a-z0-9]+)\.localhost$/i.exec(String(hostname || ''));
  return match ? `archive_${match[1].toLowerCase()}_${match[2].toLowerCase()}` : null;
}

export function archiveReplayOrigin(archiveId, replayPort, fallbackOrigin) {
  const host = archiveReplayHost(archiveId);
  return host ? `http://${host}:${replayPort}` : fallbackOrigin;
}
