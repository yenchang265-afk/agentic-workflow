/** Walk `sources` in priority order; first successful claim wins. */
export const pollOnce = async (sources) => {
    const skips = [];
    for (const source of sources) {
        const { item, skip } = await source.claimNext();
        if (item)
            return { claim: { source, item }, skips };
        if (skip)
            skips.push(skip);
    }
    return { claim: null, skips };
};
/** Merge skip reasons into one displayable reason; null when there were none. */
export const combineSkips = (skips) => {
    if (skips.length === 0)
        return null;
    if (skips.length === 1)
        return skips[0] ?? null;
    return {
        message: skips.map((s) => s.message).join(" · "),
        actionable: skips.some((s) => s.actionable),
    };
};
