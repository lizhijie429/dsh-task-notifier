# Windows toast notification helper used by the dsh-task-notifier plugin.
#
# Input is passed through the environment (not the command line) so arbitrary
# session titles / model output cannot break PowerShell quoting:
#   DSH_NOTIFY_TITLE, DSH_NOTIFY_BODY
#   DSH_NOTIFY_AUMID (optional)  - registered AppUserModelID to render as DSH
#   DSH_NOTIFY_ICON  (optional)  - raster image used as the toast banner artwork
#   DSH_NOTIFY_LAUNCH (optional) - protocol/URL opened when the toast is clicked
#   DSH_NOTIFY_ACTION (optional) - localized label for the open action button
#
# Exit codes: 0 toast shown, 1 toast unavailable (caller falls back to logging).
# A tray balloon is attempted before giving up on older/blocked toast stacks.

$ErrorActionPreference = 'Stop'

$title = $env:DSH_NOTIFY_TITLE
if ([string]::IsNullOrWhiteSpace($title)) { $title = 'DSH' }
$body = $env:DSH_NOTIFY_BODY
if ($null -eq $body) { $body = '' }

# XML 1.0 rejects most C0 control characters and SecurityElement::Escape does
# not remove them: one stray ESC byte would make LoadXml throw and drop the
# branded toast. Strip them before escaping (TAB/LF/CR survive and are escaped).
$controlPattern = '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]'
$title = $title -replace $controlPattern, ' '
$body = $body -replace $controlPattern, ' '

$escapedTitle = [System.Security.SecurityElement]::Escape($title)
$escapedBody = [System.Security.SecurityElement]::Escape($body)

# Windows PowerShell's own AUMID: always registered, used as a safe fallback.
$powershellAppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
$appId = $env:DSH_NOTIFY_AUMID
if ([string]::IsNullOrWhiteSpace($appId)) {
    # Self-contained fallback: the plugin registers DSH.TaskNotifier at mount.
    # Reading it here lets already-mounted plugin code brand new toasts too.
    $dshAppId = 'DSH.TaskNotifier'
    try {
        $null = Get-ItemProperty -LiteralPath "Registry::HKEY_CURRENT_USER\Software\Classes\AppUserModelId\$dshAppId" -ErrorAction Stop
        $appId = $dshAppId
    } catch {
        $appId = $powershellAppId
    }
}

$iconPath = $env:DSH_NOTIFY_ICON
if ([string]::IsNullOrWhiteSpace($iconPath)) {
    # Fall back to the icon shipped next to this script.
    try {
        $pluginRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
        $candidate = Join-Path $pluginRoot 'assets\tray.ico'
        if (Test-Path -LiteralPath $candidate) { $iconPath = $candidate }
    } catch {
        $iconPath = $null
    }
}
if ([string]::IsNullOrWhiteSpace($iconPath) -or -not (Test-Path -LiteralPath $iconPath)) {
    $iconPath = $null
}

# Optional in-toast logo override; the AUMID registration controls the app
# header icon, this controls the banner artwork on builds that honor it.
$imageXml = ''
if ($iconPath) {
    try {
        $iconUri = ([System.Uri]$iconPath).AbsoluteUri
        $escapedUri = [System.Security.SecurityElement]::Escape($iconUri)
        $imageXml = "<image placement=`"appLogoOverride`" hint-crop=`"circle`" src=`"$escapedUri`"/>"
    } catch {
        $imageXml = ''
    }
}

# Optional click-through: DSH registers `dsh://` and focuses the app on open.
# The plugin supplies both values; older callers without them keep the plain
# toast without an action button.
$launch = $env:DSH_NOTIFY_LAUNCH
$actionLabel = $env:DSH_NOTIFY_ACTION
if ([string]::IsNullOrWhiteSpace($actionLabel)) { $actionLabel = '打开 DSH' }
$launchAttr = ''
$actionsXml = ''
if (-not [string]::IsNullOrWhiteSpace($launch)) {
    $escapedLaunch = [System.Security.SecurityElement]::Escape($launch)
    $escapedAction = [System.Security.SecurityElement]::Escape($actionLabel)
    $launchAttr = " activationType=`"protocol`" launch=`"$escapedLaunch`""
    $actionsXml = "<actions><action content=`"$escapedAction`" activationType=`"protocol`" arguments=`"$escapedLaunch`"/></actions>"
}

function Show-Toast([string]$toastAppId) {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

    $template = @"
<toast$launchAttr>
  <visual>
    <binding template="ToastGeneric">
      <text>$escapedTitle</text>
      <text>$escapedBody</text>
      $imageXml
    </binding>
  </visual>
  $actionsXml
</toast>
"@

    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($template)
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($toastAppId)
    $notifier.Show($toast)
}

function Show-Balloon {
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    Add-Type -AssemblyName System.Drawing | Out-Null
    $icon = $null
    if ($iconPath -and $iconPath.EndsWith('.ico', [System.StringComparison]::OrdinalIgnoreCase)) {
        try { $icon = New-Object System.Drawing.Icon($iconPath) } catch { $icon = $null }
    }
    if ($null -eq $icon) { $icon = New-Object System.Drawing.Icon ([System.Drawing.SystemIcons]::Information) }
    $notifyIcon = New-Object System.Windows.Forms.NotifyIcon
    $notifyIcon.Icon = $icon
    $notifyIcon.BalloonTipTitle = $title
    $notifyIcon.BalloonTipText = $body
    $notifyIcon.Visible = $true
    $notifyIcon.ShowBalloonTip(5000)
    Start-Sleep -Milliseconds 1500
    $notifyIcon.Dispose()
}

# Try the DSH identity first; if the app identity is unusable on this Windows
# version, retry under the guaranteed Windows PowerShell identity.
try {
    try {
        Show-Toast $appId
    } catch {
        if ($appId -eq $powershellAppId) { throw }
        Show-Toast $powershellAppId
        Write-Output 'TOAST_OK_LEGACY'
        exit 0
    }
    Write-Output 'TOAST_OK'
    exit 0
} catch {
    try {
        Show-Balloon
        Write-Output 'BALLOON_OK'
        exit 0
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
}
