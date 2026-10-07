#!/bin/bash
# NVIDIA's server driver, installed with Ubuntu's own tool on the stock Ubuntu 24.04 AMI.
# Usually needs a reboot afterwards; the script says so when it does.
set -euo pipefail

DRIVER=${DRIVER:-580-server}

sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ubuntu-drivers-common

# On a fresh AWS image this pulls in a newer kernel, and the driver's prebuilt module needs
# that kernel's headers to finish installing. Without them dpkg stops with "cannot open
# linker script file /usr/src/linux-headers-<version>/scripts/module.lds". So let the first
# attempt fail, add headers for every kernel now present, and have apt finish the job.
sudo DEBIAN_FRONTEND=noninteractive ubuntu-drivers install --gpgpu "nvidia:$DRIVER" || true
for kernel in $(ls /lib/modules); do
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "linux-headers-$kernel" \
    || echo "No headers package for $kernel, skipping"
done
sudo DEBIAN_FRONTEND=noninteractive apt-get install -f -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "nvidia-utils-$DRIVER"

# sudo, because nvidia-smi run as a normal user can't create /dev/nvidia* and reports that it
# "couldn't communicate with the NVIDIA driver" even when the driver is fine.
if sudo nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv 2>/dev/null; then
  echo "GPU driver is working."
else
  echo "Driver installed for a newer kernel. Reboot (sudo reboot), then check: sudo nvidia-smi"
fi
