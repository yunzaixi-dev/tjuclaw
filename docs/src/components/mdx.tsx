import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { IllustrationPlaceholder } from './IllustrationPlaceholder';

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    IllustrationPlaceholder,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
