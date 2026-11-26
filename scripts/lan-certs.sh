#!/bin/sh
# Certificates for serving the app on your network over HTTPS (make lan), in .lan/:
#   ca.key, ca.crt   a certificate authority of your own, made once, that your phone trusts. It can
#                    only vouch for private network addresses, localhost, .local names and this
#                    computer's name, so its key can't be used to pass off any other site.
#   server.key, .crt this computer's certificate for its current address and name, made each time.
#   public/          what a phone may fetch over plain http: the authority's certificate and a page
#                    saying what to do with it.
# Usage: sh scripts/lan-certs.sh <address> <host name or ""> <https port>
set -eu
ip=$1
name=${2:-}
port=${3:-4443}
umask 077
mkdir -p .lan/public

private() {
  case "$1" in
    10.* | 192.168.* | 127.*) return 0 ;;
    172.*) n=$(echo "$1" | cut -d. -f2) && [ "$n" -ge 16 ] && [ "$n" -le 31 ] ;;
    *) return 1 ;;
  esac
}

if [ ! -s .lan/ca.key ] || [ ! -s .lan/ca.crt ]; then
  allowed="permitted;IP:10.0.0.0/255.0.0.0,permitted;IP:172.16.0.0/255.240.0.0,permitted;IP:192.168.0.0/255.255.0.0,permitted;IP:127.0.0.0/255.0.0.0,permitted;DNS:localhost,permitted;DNS:local"
  private "$ip" || allowed="$allowed,permitted;IP:$ip/255.255.255.255"
  [ -n "$name" ] && allowed="$allowed,permitted;DNS:$name"
  openssl ecparam -name prime256v1 -genkey -noout -out .lan/ca.key
  openssl req -x509 -new -key .lan/ca.key -sha256 -days 3650 -subj "/CN=notedid on your network" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" \
    -addext "nameConstraints=critical,$allowed" \
    -out .lan/ca.crt
fi

san="IP:$ip,IP:127.0.0.1,DNS:localhost"
[ -n "$name" ] && san="$san,DNS:$name"
printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\nauthorityKeyIdentifier=keyid\nsubjectKeyIdentifier=hash\n' "$san" > .lan/server.ext
# Made beside the current one, which it replaces only once it checks out.
openssl ecparam -name prime256v1 -genkey -noout -out .lan/server.new.key
openssl req -new -key .lan/server.new.key -subj "/CN=${name:-$ip}" -out .lan/server.csr
# An iPhone takes at most 825 days for a certificate from an authority you added.
openssl x509 -req -in .lan/server.csr -CA .lan/ca.crt -CAkey .lan/ca.key -CAcreateserial -days 800 -sha256 -extfile .lan/server.ext -out .lan/server.new.crt 2> /dev/null
rm -f .lan/server.csr .lan/server.ext
if ! openssl verify -CAfile .lan/ca.crt .lan/server.new.crt > /dev/null 2>&1; then
  rm -f .lan/server.new.key .lan/server.new.crt
  echo "This computer's address or name is beyond what its certificate authority may vouch for."
  echo "Move .lan/ca.key and .lan/ca.crt aside, run make lan again, and install the new certificate on your phone."
  exit 1
fi
mv .lan/server.new.key .lan/server.key
mv .lan/server.new.crt .lan/server.crt

fingerprint=$(openssl x509 -in .lan/ca.crt -noout -fingerprint -sha256 | cut -d= -f2)
echo "$fingerprint" > .lan/ca.fingerprint
cp .lan/ca.crt .lan/public/notedid-ca.crt
links="<a href=\"https://$ip:$port/\">https://$ip:$port/</a>"
[ -n "$name" ] && links="<a href=\"https://$name:$port/\">https://$name:$port/</a> (or $links)"
cat > .lan/public/index.html << HTML
<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>notedid on your network</title>
<body style="font: 16px/1.5 system-ui, sans-serif; max-width: 36rem; margin: 2rem auto; padding: 0 1rem">
<h1>notedid on your network</h1>
<p>Two steps, once per phone.</p>
<ol>
  <li>
    <p><a href="/notedid-ca.crt">Download this computer’s certificate</a>, then install and trust it:</p>
    <ul>
      <li><b>iPhone, iPad:</b> Settings → <i>Profile Downloaded</i> → Install. Then Settings → General → About → Certificate Trust Settings, and turn on <i>notedid on your network</i>.</li>
      <li><b>Android:</b> Settings → Security → Encryption &amp; credentials → Install a certificate → CA certificate (or search Settings for “CA certificate”), and pick the file you downloaded. Firefox for Android also needs: Settings → About Firefox, tap its logo five times, go back → Secret settings → <i>Use third party CA certificates</i>.</li>
    </ul>
    <p>Before installing, check that its SHA-256 fingerprint is <code style="word-break: break-all">$fingerprint</code>.</p>
  </li>
  <li><p>Open $links and install the app: on an iPhone, Safari’s Share → Add to Home Screen; on Android, the browser’s menu → Install app.</p></li>
</ol>
<p>This computer only hands out the app. Your notes stay on the phone, and sync through your Dropbox.</p>
</body>
</html>
HTML
