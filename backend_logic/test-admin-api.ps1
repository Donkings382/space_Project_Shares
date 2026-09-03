$ErrorActionPreference = "Stop"
$base = "http://localhost:4000"
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$adminEmail = "admin@yourdomain.com"
$userEmail = "test.user.$stamp@example.com"
$pw = "Passw0rd!Test"

function PostJson($url, $body, $token = $null) {
  $headers = @{ "Content-Type" = "application/json" }
  if ($token) { $headers["Authorization"] = "Bearer $token" }
  return Invoke-RestMethod -Uri $url -Method Post -Headers $headers -Body ($body | ConvertTo-Json) -TimeoutSec 20
}
function PutJson($url, $body, $token = $null) {
  $headers = @{ "Content-Type" = "application/json" }
  if ($token) { $headers["Authorization"] = "Bearer $token" }
  return Invoke-RestMethod -Uri $url -Method Put -Headers $headers -Body ($body | ConvertTo-Json) -TimeoutSec 20
}
function GetAuth($url, $token) {
  $headers = @{ Authorization = "Bearer $token" }
  return Invoke-RestMethod -Uri $url -Method Get -Headers $headers -TimeoutSec 20
}
function TryGetAuth($url, $token) {
  try { return GetAuth $url $token } catch { Write-Output ("  (non-fatal) " + $_.Exception.Message); return $null }
}

Write-Output "== registering admin =="
try {
  PostJson "$base/api/auth/register" @{ name="Test Admin"; username="tadmin_fixed"; email=$adminEmail; password=$pw; confirmPassword=$pw; recoveryContact="rec_fixed@example.com" } | Out-Null
  Write-Output "admin registered"
} catch {
  Write-Output ("admin register status: " + $_.Exception.Message)
}

Write-Output "== registering user =="
PostJson "$base/api/auth/register" @{ name="Test User $stamp"; username="tuser_$stamp"; email=$userEmail; password=$pw; confirmPassword=$pw; recoveryContact="+1000000000" } | Out-Null
Write-Output "user registered"

Write-Output "== login user (should succeed) =="
$u = PostJson "$base/api/auth/login" @{ identifier=$userEmail; password=$pw }
$userToken = $u.token
Write-Output ("user role: " + $u.user.role)

Write-Output "== login with wrong password (expect LOGIN_FAILED) =="
try { PostJson "$base/api/auth/login" @{ identifier=$userEmail; password="Wr0ng!Pass" } | Out-Null } catch { Write-Output ("got 401: " + $_.Exception.Message) }

Write-Output "== login admin =="
$adminToken = $null
try {
  $a = PostJson "$base/api/auth/login" @{ identifier=$adminEmail; password=$pw }
  $adminToken = $a.token
  Write-Output ("admin role: " + $a.user.role)
} catch { Write-Output ("admin login failed: " + $_.Exception.Message) }

if ($adminToken) {
  Write-Output "== PUT /api/kyc/profile (user) =="
  $p = PutJson "$base/api/kyc/profile" @{ legalName="Test User Full"; dob="1990-01-15"; nationality="United States"; address="1 Main St, Springfield"; phoneCode="+1"; phone="5551234567"; idType="passport"; idNumber="G12345678XYZ" } $userToken
  Write-Output ("profile saved, masked idNumber: " + $p.profile.idNumber)

  Write-Output "== GET /api/kyc/profile (user) => idNumber must be masked =="
  $gp = TryGetAuth "$base/api/kyc/profile" $userToken
  if ($gp) {
    Write-Output ("masked idNumber: " + $gp.profile.idNumber)
  }

  Write-Output "== GET /api/kyc/profile (user directly via admin token) => masked =="
  $gp2 = TryGetAuth "$base/api/kyc/profile" $adminToken
  if ($gp2) {
    Write-Output ("admin-request masked idNumber: " + $gp2.profile.idNumber)
  }

  Write-Output "== GET /api/admin/kyc (admin) => idNumber must be full =="
  $kyc = GetAuth "$base/api/admin/kyc" $adminToken
  $profs = @($kyc.documents | Where-Object { $_.user.kycProfile } | ForEach-Object { $_.user.kycProfile })
  if ($profs.Count -gt 0) {
    Write-Output ("admin decrypted idNumber: " + $profs[0].idNumber)
  } else {
    Write-Output "no kyc documents yet with profile"
  }

  Write-Output "== GET /api/admin/logs (admin) =="
  $logs = GetAuth "$base/api/admin/logs" $adminToken
  Write-Output ("total logs: " + $logs.total)
  $logs.logs | Select-Object -First 12 | ForEach-Object { Write-Output ("  [" + $_.action + "] user=" + ($_.user.email) + " ip=" + $_.ipAddress) }

  Write-Output "== GET /api/admin/logs?action=LOGIN_FAILED (admin) =="
  $ul = GetAuth "$base/api/admin/logs?action=LOGIN_FAILED" $adminToken
  Write-Output ("LOGIN_FAILED count: " + $ul.total)

  Write-Output "== GET /api/admin/logs as NON-admin user (expect 403) =="
  try {
    GetAuth "$base/api/admin/logs" $userToken | Out-Null
    Write-Output "!! unexpected: user could access admin logs"
  } catch { Write-Output ("403 as expected: " + $_.Exception.Message) }

  Write-Output "== GET /api/admin/uploads/:file (admin) =="
  try {
    $img = Invoke-WebRequest -Uri "$base/api/admin/uploads/85cfdfbabf27b768e719d25b7df6c8d9" -Headers @{ Authorization = "Bearer $adminToken" } -TimeoutSec 20
    Write-Output ("upload status: " + $img.StatusCode + " content-type: " + $img.Headers["Content-Type"] + " length: " + $img.RawContentLength)
  } catch { Write-Output ("upload fetch failed: " + $_.Exception.Message) }

  Write-Output "== GET /api/admin/users/:id/signin-information (admin) =="
  $users = GetAuth "$base/api/admin/users" $adminToken
  $firstUser = $users.users[0]
  $si = GetAuth ("$base/api/admin/users/" + $firstUser.id + "/signin-information") $adminToken
  Write-Output ("signin info: lastReset=" + $si.signinInformation.lastPasswordResetAt + " method=" + $si.signinInformation.lastPasswordResetMethod + " resets=" + $si.signinInformation.resetRequestCount)
}

Write-Output "== DONE =="