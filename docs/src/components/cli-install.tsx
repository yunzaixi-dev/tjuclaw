'use client';

import { Check, Copy } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

const commands = [
  { name: 'macOS / Linux', command: 'curl -fsSL https://tjuclaw-release.zaixi.dev/cli/install.sh | sh' },
  { name: 'Windows · PowerShell', command: 'irm https://tjuclaw-release.zaixi.dev/cli/install.ps1 | iex' },
];

export function CliInstall() {
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  async function copy(name: string, command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(name);
      setError('');
    } catch {
      setCopied('');
      setError('无法访问剪贴板，请手动选择并复制指令。');
    }
  }

  return <section className="nx-cli-install" id="cli-install" aria-labelledby="cli-install-title">
    <h3 id="cli-install-title">一条命令，安装 TJUClaw CLI。</h3>
    <p>支持 macOS、Linux、Windows 的 x64 与 arm64。安装脚本自动选择平台，并在安装前校验 SHA256。</p>
    <div className="nx-cli-commands">
      {commands.map(({ name, command }) => <div className="nx-cli-command" key={name}>
        <div className="nx-cli-command-head"><strong>{name}</strong>
          <button type="button" onClick={() => void copy(name, command)} aria-label={`复制 ${name} 安装指令`}>
            {copied === name ? <Check size={15} /> : <Copy size={15} />}{copied === name ? '已复制' : '复制'}
          </button>
        </div>
        <pre tabIndex={0} aria-label={`${name} 安装指令`}><code>{command}</code></pre>
      </div>)}
    </div>
    <p className="nx-cli-help">指令会执行远程安装脚本；希望先检查脚本或手动下载？<Link href="/docs/cli">查看安装、校验与首次使用说明 →</Link></p>
    <p role="status" className="nx-cli-feedback">{error || (copied ? `${copied} 安装指令已复制。` : '')}</p>
  </section>;
}
