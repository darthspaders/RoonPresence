function normalize(value) {
  return String(value || "").toLowerCase();
}

function makeZoneMatcher(pattern) {
  const needles = String(pattern || "HQPlayer")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  return function isHqPlayerZone(zone) {
    const names = [
      zone?.display_name,
      zone?.zone_name,
      ...(zone?.outputs || []).flatMap((output) => [
        output?.display_name,
        output?.zone_name,
        output?.source_controls?.[0]?.display_name
      ])
    ].map(normalize);

    return needles.some((needle) => names.some((name) => name.includes(needle)));
  };
}

module.exports = { makeZoneMatcher };
