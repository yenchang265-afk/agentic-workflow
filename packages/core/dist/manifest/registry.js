const composeHooks = new Map();
const validateHooks = new Map();
const claimPredicates = new Map();
export const registerComposeHook = (ref, hook) => void composeHooks.set(ref, hook);
export const registerValidateHook = (ref, hook) => void validateHooks.set(ref, hook);
/** Resolve a compose hook by ref; throws on a dangling manifest reference. */
export const resolveComposeHook = (ref) => {
    const hook = composeHooks.get(ref);
    if (!hook)
        throw new Error(`unknown compose hook "${ref}" — register it before driving this loop kind`);
    return hook;
};
/** Resolve a validate hook by ref, or null when the manifest names none. */
export const resolveValidateHook = (ref) => ref ? (validateHooks.get(ref) ?? null) : null;
export const registerClaimPredicate = (ref, predicate) => void claimPredicates.set(ref, predicate);
/** Resolve a claim predicate by ref; throws on a dangling manifest reference. */
export const resolveClaimPredicate = (ref) => {
    const predicate = claimPredicates.get(ref);
    if (!predicate)
        throw new Error(`unknown claim predicate "${ref}" — register it before polling this loop kind`);
    return predicate;
};
