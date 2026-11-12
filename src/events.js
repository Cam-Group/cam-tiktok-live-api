// Shared SSE contract. Use event fields only; never fetch profiles or images.
const text = value => typeof value === 'string' ? value : '';
const id = value => typeof value === 'string' ? value : Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
const count = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

function imageUrl(image) {
  if (!Array.isArray(image?.urlList)) return '';
  for (const value of image.urlList) {
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    } catch {}
  }
  return '';
}

function user(data) {
  const avatarThumb = imageUrl(data?.avatarThumb);
  const avatarMedium = imageUrl(data?.avatarMedium);
  const avatarLarge = imageUrl(data?.avatarLarge);
  return {
    id: id(data?.id),
    nickname: text(data?.nickname),
    uniqueId: text(data?.uniqueId),
    avatarUrl: avatarThumb || avatarMedium || avatarLarge,
    avatarThumb, avatarMedium, avatarLarge,
  };
}

export function normalizeEvent(type, data = {}) {
  let diamonds = null;
  if (type === 'gift') {
    diamonds = count(data.diamondTotal);
    if (!data.isStreakOver || diamonds === null || diamonds <= 0) return null;
  }
  const common = {
    eventId: id(data.common?.msgId),
    roomId: id(data.common?.roomId),
    ts: Date.now(),
  };
  if (type === 'viewers') {
    return { ...common, viewerCount: count(data.viewerCount), totalUser: count(data.totalUser) };
  }
  const base = { ...common, user: user(data.user) };
  switch (type) {
    case 'chat': return { ...base, text: text(data.content) };
    case 'gift': {
      return {
        ...base,
        gift: text(data.gift?.name),
        diamonds,
        giftId: id(data.gift?.id ?? data.giftId),
        giftImageUrl: imageUrl(data.gift?.image) || imageUrl(data.gift?.icon),
        diamondCount: count(data.gift?.diamondCount),
        repeatCount: Math.max(count(data.repeatCount) ?? 1, 1),
        comboId: id(data.groupId),
        isCombo: data.isCombo === true,
        isStreakOver: true,
      };
    }
    case 'like': return { ...base, count: count(data.count), total: count(data.total) };
    case 'follow': return { ...base, followCount: count(data.followCount) };
    case 'share': return { ...base, count: count(data.shareCount), target: text(data.shareTarget) };
    case 'join': return { ...base, memberCount: count(data.memberCount) };
    default: throw new Error(`Unsupported event type: ${type}`);
  }
}
