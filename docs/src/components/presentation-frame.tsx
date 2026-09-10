'use client';

import { useSyncExternalStore } from 'react';

const productionSource = '/presentation/';
const subscribe = () => () => {};

function getBrowserSource() {
  if (process.env.NODE_ENV !== 'development') return productionSource;

  const url = new URL(productionSource, window.location.href);
  url.port = '3031';
  return url.href;
}

export function PresentationFrame() {
  const source = useSyncExternalStore(subscribe, getBrowserSource, () => productionSource);

  return (
    <iframe
      src={source}
      title="TJUClaw 项目演示"
      allow="fullscreen"
    />
  );
}
