/** Quote one value as a literal POSIX shell argument. */
export function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

/** Quote one value as a literal PowerShell single-quoted string. */
export function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function appleScriptString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\r', '').replaceAll('\n', '\\n')
}

/** Build the platform command routed through DSH's existing shell executor. */
export function systemNotificationCommand(
  platform: NodeJS.Platform,
  title: string,
  body: string,
): string {
  if (platform === 'darwin') {
    const script = `display notification "${appleScriptString(body)}" with title "${appleScriptString(title)}"`
    return `/usr/bin/osascript -e ${quotePosix(script)}`
  }
  if (platform === 'win32') {
    return [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$notification = New-Object System.Windows.Forms.NotifyIcon',
      '$notification.Icon = [System.Drawing.SystemIcons]::Information',
      `$notification.BalloonTipTitle = ${quotePowerShell(title)}`,
      `$notification.BalloonTipText = ${quotePowerShell(body)}`,
      '$notification.Visible = $true',
      '$notification.ShowBalloonTip(5000)',
      'Start-Sleep -Milliseconds 5500',
      '$notification.Dispose()',
    ].join('; ')
  }
  return `command -v notify-send >/dev/null 2>&1 && notify-send -- ${quotePosix(title)} ${quotePosix(body)}`
}
