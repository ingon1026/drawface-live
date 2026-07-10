# Derived runtime image: upstream FLP image + X11 client libs for cv2.imshow (WSLg).
# Upstream image lacks libSM/libXext needed by OpenCV's Qt xcb plugin.
FROM shaoguo/faster_liveportrait:v3
RUN apt-get update && apt-get install -y --no-install-recommends libsm6 libxext6 libxrender1 \
    && rm -rf /var/lib/apt/lists/*
ENV PATH=/root/miniconda3/bin:$PATH
# Image ships TRT at /opt but only exports it in .bashrc; needed for non-login `docker run` too.
ENV LD_LIBRARY_PATH=/opt/TensorRT-8.6.1.6/lib:/usr/local/cuda/lib64
# Repo commit 8aad360 is newer than the v3 image; colorama was added upstream after the image build.
RUN /root/miniconda3/bin/pip install --no-cache-dir colorama
