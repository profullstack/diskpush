# A minimal OpenSSH + rsync host for the integration tests.
#
# Key-only authentication, matching how DiskPush actually connects: it uses
# BatchMode, so a container that fell back to passwords would hang rather
# than fail.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server rsync ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd

RUN useradd --create-home --shell /bin/bash diskpush \
 && mkdir -p /home/diskpush/.ssh \
 && chmod 700 /home/diskpush/.ssh

COPY test_key.pub /home/diskpush/.ssh/authorized_keys
RUN chown -R diskpush:diskpush /home/diskpush/.ssh \
 && chmod 600 /home/diskpush/.ssh/authorized_keys

RUN sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config

RUN mkdir -p /data && chown diskpush:diskpush /data

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
