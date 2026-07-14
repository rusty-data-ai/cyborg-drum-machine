#!/usr/bin/env bash
# Reproducible dataset download. See docs/data.md for licenses.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/avp data/avp-lvt data/beatboxset1/Annotations_DR data/beatboxset1/Annotations_HT data/samples

# AVP (CC BY 4.0)
if [ ! -d data/avp/AVP_Dataset ]; then
  curl -L -o data/avp/AVP_Dataset.zip "https://zenodo.org/records/3245959/files/AVP_Dataset.zip?download=1"
  unzip -q -o data/avp/AVP_Dataset.zip -d data/avp/ && rm data/avp/AVP_Dataset.zip
fi

# AVP-LVT (CC BY 4.0) — phoneme annotations
if [ ! -d data/avp-lvt/AVP-LVT_Dataset ]; then
  curl -L -o data/avp-lvt/AVP-LVT_Dataset.zip "https://zenodo.org/records/5578744/files/AVP-LVT_Dataset.zip?download=1"
  unzip -q -o data/avp-lvt/AVP-LVT_Dataset.zip -d data/avp-lvt/ && rm data/avp-lvt/AVP-LVT_Dataset.zip
fi

# beatboxset1 (CC BY-SA 3.0)
cd data/beatboxset1
for f in battleclip_daq callout_Pneumatic callout_Turn-Table callout_adiao callout_azeem \
         callout_luckeymonkey callout_mcld callout_mouss putfile_bui putfile_dbztenkaichi \
         putfile_pepouni putfile_vonny putfile_william snare_hex; do
  [ -f "${f}.wav" ] || curl -sL -o "${f}.wav" "https://archive.org/download/beatboxset1/${f}.wav"
  [ -f "Annotations_DR/${f}.csv" ] || curl -sL -o "Annotations_DR/${f}.csv" "https://archive.org/download/beatboxset1/Annotations_DR/${f}.csv"
  [ -f "Annotations_HT/${f}.csv" ] || curl -sL -o "Annotations_HT/${f}.csv" "https://archive.org/download/beatboxset1/Annotations_HT/${f}.csv"
done
cd ../..

# TR-808 kit (CC0)
[ -d data/samples/tr808 ] || git clone --depth 1 https://github.com/tidalcycles/sounds-tr808-fischer data/samples/tr808

echo "All datasets ready."
