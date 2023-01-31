# rm akash
AKASH_VERSION="$(curl -s -L https://api.github.com/repos/ovrclk/provider-services/releases/latest | jq -r '.tag_name')"
echo $AKASH_VERSION
#NOTE that this download may take several minutes to complete
curl -sfL https://raw.githubusercontent.com/akash-network/provider/main/install.sh | bash -s -- "$AKASH_VERSION"
mv bin/provider-services akash
rm bin -r