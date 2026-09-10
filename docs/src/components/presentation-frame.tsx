'use client';

import { useSyncExternalStore } from 'react';

const productionSource = '/presentation/';
const initialSource = process.env.NODE_ENV === 'development' ? 'about:blank' : productionSource;
const subscribe = () => () => {};

function getBrowserSource() {
  if (process.env.NODE_ENV !== 'development') return productionSource;

  const url = new URL(productionSource, window.location.href);
  // Slidev binds localhost, which can resolve to IPv6-only ::1 on this host.
  // Let the browser resolve localhost instead of copying a literal IPv4 address.
  if (url.hostname === '127.0.0.1' || url.hostname === '[::1]') {
    url.hostname = 'localhost';
  }
  url.port = '3031';
  return url.href;
}

export function PresentationFrame() {
  const source = useSyncExternalStore(subscribe, getBrowserSource, () => initialSource);

  return (
    <iframe
      src={source}
      title="TJUClaw 项目演示"
      allow="fullscreen"
    />
  );
}
