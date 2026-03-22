---
paths:
  - "src/store/**"
  - "src/hooks/**"
  - "src/components/**"
  - "src/utils/testUtils.tsx"
  - "src/store/__tests__/**"
---

## Zustand Immutable Updates

Always use immutable updates in Zustand state. Never mutate state directly.

```typescript
set((state) => ({
  cache: {
    ...state.cache,
    imageViewStates: new Map(state.cache.imageViewStates).set(path, viewState)
  }
}))
```

## Image Loading Logic

- New images: Use `fitToWindow()` for initial display
- Returning to viewed images: Use `updateImageDimensions()` to preserve saved view state
- Check `cache.imageViewStates.has(path)` to determine which behavior to use

## Adding New Store Actions

1. Add action to `AppActions` interface
2. Implement in store with immutable updates
3. Update test mocks in `src/utils/testUtils.tsx`
4. Add unit tests in `src/store/__tests__/index.test.ts`
