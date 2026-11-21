FROM --platform=linux/amd64 bugzilla/bugzilla-perl-slim-mariadb:latest

RUN apt-get update && apt-get install -y --no-install-recommends \
    apache2 \
    ca-certificates \
    mariadb-client \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /var/www/bugzilla \
    && curl -fsSL https://github.com/bugzilla/bugzilla/archive/refs/tags/release-5.2.tar.gz \
       | tar -xz --strip-components=1 -C /var/www/bugzilla

# Ensure Bugzilla CGI scripts use /usr/local/bin/perl and find /app/local/lib/perl5 under -T taint mode
RUN sed -i '1s|^#!/usr/bin/perl|#!/usr/local/bin/perl|' /var/www/bugzilla/*.cgi /var/www/bugzilla/*.pl \
    && cp -a /app/local/lib/perl5/. /var/www/bugzilla/lib/

ENV PERL5LIB=/app/local/lib/perl5

RUN a2enmod cgi rewrite headers expires

COPY bugzilla.conf /etc/apache2/sites-available/000-default.conf
COPY answers.txt /var/www/bugzilla/answers.txt
COPY seed.pl /var/www/bugzilla/seed.pl
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /var/www/bugzilla/seed.pl

WORKDIR /var/www/bugzilla
EXPOSE 80

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
