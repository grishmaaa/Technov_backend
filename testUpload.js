import { Storage } from '@google-cloud/storage';

const rawKey = `{
  \"type\": \"service_account\",
  \"project_id\": \"digital-well-454208-k2\",
  \"private_key_id\": \"f12db292cf3ce4cd45e1d7c48b139c5debed366a\",
  \"private_key\": \"-----BEGIN PRIVATE KEY-----\\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDrKn04DLhl8Ta0\\n5ejdy5t0Kcs9JJANXySVNISFf4Ym2ydDmP5l0gUng+QFNlMQ53/hOrpDnq8LAD1C\\nT8qnuKBqWKp0081VSBRkx+JFy5lp3E1MISukWoO7iiFdeau1yWeHbHIEYrxhAsFv\\nZYfC0MAUzdITHs/kXXEXsIMcEU+FXkbUwx7fBe3cdoCJ+zKfHR+rIPW1ddM17VK6\\n47Xhzwx7bw0MKwCqAAqyTkpOmv6qtnehW9EpuVCCxyLX5YCyIz2vXWMOaGydIjpw\\n5TPmo1Gng984shg13Nv00kGiKrvJDTxfKizYJmN4FgviP3hgKkk9P4K3bEAdlsb7\\nPLM0ounjAgMBAAECggEAZ/IX9zZoK2c7bypQi/j7dZUjqJsIsWBkoy7bhMahXXtx\\nF4gAqrDyZkz99O/WN5qcA8oZmtoBNTOd4Dm0sf4BqgAXGBymnhOGMCXJ9l/QJ+Kg\\nqA3hZHw9zh94MAEfzPKBOHLO0vFxos+9AKg4Ifxzar6vJJRx/9btrjLvQPDF3YS9\\njIYcVfrPG63YnfxlQxwahd0MQiIRe0Fvwp/Vn2FHiK2pvhibQ/v89tZENvGS/BtV\\nVkCdVtrM+aCHWs+ohSnF6Ewwb1hw+sAGT+BYdMnn5vOCxaIfAOCDLgCFJRCYj0rI\\n8/6QBZ+y43LmmKx83uBwMHlR/roE3msgTzXXgTrlQQKBgQD4wYkmfX0oFnML5pWs\\nsl9xC7o9KJZklEldTCjfD9b1apLSPSniM9KgB0CDuURzcMacdkqiaJWJBtx/dmQT\\njg2VA+4Zp8efymCIeT/VIXXA1W7qXUr3wJ5FNJZXbvbtU9e4wwC4TEg3g7ep+G0r\\nR+qzbU51q58no+Or2OHqYIzA3wKBgQDyA6Pwo4DzYzQhCd2KdDAF2PQrlZVg8IOx\\nhqEsX2BPQQfmbozy8PzWmaIlM+9OhEGSMXK3EPUVkSXyHBaSNxUQ7pR3v30YKO3x\\ndKc0lqMquWC68dd/KvHGM+9kGx00Mbugm3WP8MHjP5yUSjot4wk55VmXr5MXRQd1\\n9h0TbH3jfQKBgC1vG9+919g0kXrA+OF8CtaY78Ev4pgoRWYW/PgQ6pAUkRB5P2cj\\nU/sKmAv3ELuNA5mcOXGEbJuEd02IkCrKLUzkVN62uE1FJ3CFxNTmsZ0w3ntL4t9x\\nfPbi7fq2N7+NKr+CTmVa+W26TxdqWnYnQoTXGBeB6yXQV0sR5+FpFQw9AoGBAJUU\\n3wFWhxHm827CuAEZD5gajFbo30sG/ej2yQQfgKFxqt8tDJB/GRFNNI/8TRct64KW\\nCVdyD7eIYTqiSNkrK0Px4+1cPUALvn+132ZKwRqJdWfToG8K0kLJLVeaSEQlurH1\\n8daIdbd6MQc8Llij+cP7X1RMaKy17iGhSUn01Bu1AoGBAJdNcZWEfU/omFCXZ+iM\\n3aKzarT5NZ8tnfdOinQvre9hfFf7wxwl5VDdMVY07UQxSID3IWKCvlJ1q20xIMA1\\nVAfWu7ZVWBuwK9X8nzwqJz1RTgfQdzsfaziEjx25aF4a68GnxXzd3dhXO17vEv8H\\nrOAhypdqyqD6KLpRQogqw2M/\\n-----END PRIVATE KEY-----\\n\",
  \"client_email\": \"technov@digital-well-454208-k2.iam.gserviceaccount.com\",
  \"client_id\": \"107270436287406045286\",
  \"auth_uri\": \"https://accounts.google.com/o/oauth2/auth\",
  \"token_uri\": \"https://oauth2.googleapis.com/token\",
  \"auth_provider_x509_cert_url\": \"https://www.googleapis.com/oauth2/v1/certs\",
  \"client_x509_cert_url\": \"https://www.googleapis.com/robot/v1/metadata/x509/technov%40digital-well-454208-k2.iam.gserviceaccount.com\",
  \"universe_domain\": \"googleapis.com\"
}`;

async function run() {
    try {
        console.log("Starting upload test with stringified JSON...");
        let cleanedKey = rawKey;
        // Fix Railway's escaped quotes
        if (cleanedKey.includes('\\\"')) {
            cleanedKey = cleanedKey.replace(/\\"/g, '"');
        }
        
        const parsedKey = JSON.parse(cleanedKey);
        // Fix escaped newlines in the private key
        if (parsedKey.private_key && parsedKey.private_key.includes('\\n')) {
            parsedKey.private_key = parsedKey.private_key.replace(/\\n/g, '\n');
        }

        const clientConfig = { credentials: parsedKey };
        const storage = new Storage(clientConfig);
        const bucket = storage.bucket("technov-assets-bucket");
        const file = bucket.file('test-upload-123.txt');
        await file.save('Hello from test script!', {
            metadata: { contentType: 'text/plain' },
            public: true,
            resumable: false
        });
        console.log("Upload successful!");
    } catch (e) {
        console.error("UPLOAD FAILED:");
        console.error(e);
    }
}
run();
