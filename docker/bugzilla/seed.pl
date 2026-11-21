#!/usr/local/bin/perl
use strict;
use warnings;
use lib qw(. lib /app/local/lib/perl5);

use Bugzilla;
use Bugzilla::Config;
use Bugzilla::Constants;
use Bugzilla::User;
use Bugzilla::Group;
use Bugzilla::Product;
use Bugzilla::Component;
use Bugzilla::Version;
use Bugzilla::Bug;
use Bugzilla::Attachment;
use Bugzilla::FlagType;

Bugzilla->usage_mode(USAGE_MODE_CMDLINE);

my $dbh = Bugzilla->dbh;
my $admin = Bugzilla::User->check({ name => 'admin@bugzilla.local' });
Bugzilla->set_user($admin);

# 1. Configure core parameters (urlbase, mail_delivery_method=None)
Bugzilla::Config::SetParam('urlbase', 'http://localhost:18080/');
Bugzilla::Config::SetParam('mail_delivery_method', 'None');
Bugzilla::Config::write_params();

# 2. Ensure groups exist: insider + sec-private
my $insider_grp = Bugzilla::Group->new({ name => 'insider' });
if (!$insider_grp) {
    $insider_grp = Bugzilla::Group->create({
        name        => 'insider',
        description => 'Users who can see and post private comments',
        isbuggroup  => 0,
    });
}
Bugzilla::Config::SetParam('insidergroup', 'insider');
Bugzilla::Config::write_params();
my $sec_grp = Bugzilla::Group->new({ name => 'sec-private' });
if (!$sec_grp) {
    $sec_grp = Bugzilla::Group->create({
        name        => 'sec-private',
        description => 'Restricted security bugs',
        isbuggroup  => 1,
    });
}

# Add admin to insider & sec-private
for my $grp ($insider_grp, $sec_grp) {
    my ($exists) = $dbh->selectrow_array(
        'SELECT 1 FROM user_group_map WHERE user_id = ? AND group_id = ? AND isbless = 0',
        undef, $admin->id, $grp->id
    );
    if (!$exists) {
        $dbh->do(
            'INSERT INTO user_group_map (user_id, group_id, isbless, grant_type) VALUES (?, ?, 0, ?)',
            undef, $admin->id, $grp->id, GRANT_DIRECT
        );
    }
}

# 3. Ensure non-insider user exists (reporter@bugzilla.local)
my $reporter = Bugzilla::User->new({ name => 'reporter@bugzilla.local' });
if (!$reporter) {
    $reporter = Bugzilla::User->create({
        login_name    => 'reporter@bugzilla.local',
        realname      => 'External Reporter',
        cryptpassword => 'ReporterPass123!',
    });
}
# Give reporter editbugs & canconfirm (so they can file/edit public bugs, but NOT insider)
for my $gname (qw(editbugs canconfirm)) {
    my $g = Bugzilla::Group->new({ name => $gname });
    next unless $g;
    my ($exists) = $dbh->selectrow_array(
        'SELECT 1 FROM user_group_map WHERE user_id = ? AND group_id = ? AND isbless = 0',
        undef, $reporter->id, $g->id
    );
    if (!$exists) {
        $dbh->do(
            'INSERT INTO user_group_map (user_id, group_id, isbless, grant_type) VALUES (?, ?, 0, ?)',
            undef, $reporter->id, $g->id, GRANT_DIRECT
        );
    }
}

# 4. Deterministic API keys for E2E testing
my %keys = (
    $admin->id    => 'bz_e2e_admin_api_key_0123456789abcdef',
    $reporter->id => 'bz_e2e_reporter_api_key_fedcba9876543210',
);
for my $uid (keys %keys) {
    my $key = $keys{$uid};
    my ($exists) = $dbh->selectrow_array(
        'SELECT 1 FROM user_api_keys WHERE api_key = ?',
        undef, $key
    );
    if (!$exists) {
        $dbh->do(
            'INSERT INTO user_api_keys (user_id, api_key, description, revoked) VALUES (?, ?, ?, 0)',
            undef, $uid, $key, 'E2E automated test key'
        );
    }
}

# Refresh admin user groups
$admin = Bugzilla::User->check({ name => 'admin@bugzilla.local' });
Bugzilla->set_user($admin);

# 5. Ensure Product PICOS + Component Routing + Version 1.0 + sec-private group control
my $product = Bugzilla::Product->new({ name => 'PICOS' });
if (!$product) {
    $product = Bugzilla::Product->create({
        name        => 'PICOS',
        description => 'PICOS Network OS',
        version     => '1.0',
    });
}
my $component = Bugzilla::Component->new({ name => 'Routing', product => $product });
if (!$component) {
    Bugzilla::Component->create({
        name         => 'Routing',
        product      => $product,
        description  => 'L3 routing and uRPF',
        initialowner => $admin->login,
    });
}
$dbh->do(
    'INSERT IGNORE INTO group_control_map (group_id, product_id, entry, membercontrol, othercontrol, canedit) VALUES (?, ?, 0, ?, ?, 0)',
    undef, $sec_grp->id, $product->id, CONTROLMAPSHOWN, CONTROLMAPNA
);

# 6. Ensure needinfo flag type exists for PICOS
my ($needinfo_id) = $dbh->selectrow_array("SELECT id FROM flagtypes WHERE name = 'needinfo'");
if (!$needinfo_id) {
    Bugzilla::FlagType->create({
        name             => 'needinfo',
        description      => 'Need more information from user',
        target_type      => 'bug',
        is_active        => 1,
        is_requestable   => 1,
        is_requesteeble  => 1,
        is_multiplicable => 1,
        inclusions       => ['0:0'],
        exclusions       => [],
    });
}

# 7. Seed initial bugs if none exist yet
my ($bug_count) = $dbh->selectrow_array('SELECT COUNT(*) FROM bugs');
if (!$bug_count) {
    my $bug1 = Bugzilla::Bug->create({
        product      => 'PICOS',
        component    => 'Routing',
        version      => '1.0',
        short_desc   => 'uRPF loose mode drops default route packets on ECMP',
        bug_severity => 'normal',
        priority     => 'High',
        op_sys       => 'All',
        rep_platform => 'All',
        comment      => 'Initial reproduction log: packets dropped when default route points via ECMP.',
        assigned_to  => $admin->login,
    });

    # Add a text attachment to bug1
    Bugzilla::Attachment->create({
        bug         => $bug1,
        data        => "2026-11-21T08:00:00Z ERROR urpf-daemon: fib lookup missed default route ecmp=2\n2026-11-21T08:00:01Z INFO packet dropped count=42\n",
        description => 'urpf-debug.log',
        filename    => 'urpf-debug.log',
        mimetype    => 'text/plain',
        ispatch     => 0,
        isprivate   => 0,
    });

    # Create Bug 2 restricted to sec-private group
    my $bug2 = Bugzilla::Bug->create({
        product      => 'PICOS',
        component    => 'Routing',
        version      => '1.0',
        short_desc   => 'Confidential security vulnerability in BGP parser',
        bug_severity => 'critical',
        priority     => 'Highest',
        op_sys       => 'All',
        rep_platform => 'All',
        comment      => 'TOP-SECRET-EXPLOIT-DETAILS: only sec-private members may read this.',
        assigned_to  => $admin->login,
        groups       => ['sec-private'],
    });

    print "SEEDED_BUGS: public=" . $bug1->id . " restricted=" . $bug2->id . "\n";
} else {
    print "SEED_SKIPPED: existing_bugs=$bug_count\n";
}
print "SEED_COMPLETE\n";
