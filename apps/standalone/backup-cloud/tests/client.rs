use markiro_backup_cloud::client::{public_ip, RemoteObject, TransferUrl};
use uuid::Uuid;

#[test]
fn transfer_urls_are_provider_owned_https_without_credentials() {
    for url in [
        "https://uploader.disk.yandex.net/upload/a?signature=x",
        "https://uploader42.disk.yandex.net/upload/a?signature=x",
        "https://downloader.disk.yandex.ru/disk/a?signature=x",
        "https://s123nrg.storage.yandex.net/file?signature=x",
    ] {
        let signed = TransferUrl::parse(url).unwrap();
        assert!(!format!("{signed:?}").contains("signature"));
    }
    for url in [
        "http://uploader.disk.yandex.net/upload",
        "https://127.0.0.1/disk",
        "https://markiro.ru/disk",
        "https://uploader.disk.yandex.net.evil.example/a",
        "https://unknown.disk.yandex.net/a",
        "https://user:password@downloader.disk.yandex.ru/disk/a",
        "https://downloader.disk.yandex.ru:444/disk/a",
        "https://downloader.disk.yandex.ru/disk/a#secret",
        "https://s123nrg.storage.yandex.net.evil.example/file",
        "https://nested.s123nrg.storage.yandex.net/file",
        "https://storage.yandex.net/file",
    ] {
        assert!(TransferUrl::parse(url).is_err(), "{url}");
    }
}

#[test]
fn private_loopback_linklocal_and_mapped_ips_are_refused() {
    for ip in [
        "127.0.0.1",
        "10.0.0.1",
        "192.168.1.1",
        "172.16.0.1",
        "169.254.169.254",
        "0.0.0.0",
        "100.64.0.1",
        "::1",
        "::ffff:127.0.0.1",
        "fe80::1",
        "fc00::1",
    ] {
        assert!(!public_ip(ip.parse().unwrap()), "{ip}");
    }
    assert!(public_ip("77.88.21.127".parse().unwrap()));
}

#[test]
fn remote_paths_are_built_only_from_uuid_and_fixed_names() {
    let host = Uuid::new_v4();
    let snapshot = Uuid::new_v4();
    assert_eq!(
        RemoteObject::new(host, snapshot, "database.age")
            .unwrap()
            .path(),
        format!("app:/backups/v1/{host}/{snapshot}/database.age")
    );
    for name in [
        "../credentials.dpapi",
        "database.age/../secret",
        "latest.json",
        "https://markiro.ru/a",
    ] {
        assert!(RemoteObject::new(host, snapshot, name).is_err());
    }
}
