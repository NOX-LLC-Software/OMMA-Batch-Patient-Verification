const express = require('express');
const multer = require('multer');
const axios = require('axios');
const CSVParser = require('csv-parser');
const ObjectsToCsv = require('objects-to-csv');
const fs = require('fs');
const path = require('path');  // Make sure you've added this line
const upload = multer({ dest: 'uploads/' });

const http = require('http');
const { Server } = require("socket.io");

const app = express();

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const io = new Server(server);

io.on('connection', (socket) => {
    console.log('a user connected');
    socket.on('disconnect', () => {
        console.log('user disconnected');
    });
});

function format_patient_license(inputString) {
    // Remove all non-alphanumeric characters and convert to uppercase
    let cleanString = inputString.replace(/[^a-z0-9]/gi, '').toUpperCase();
  
    // Define the pattern for chunks: 2 characters, followed by five groups of four, then 2 at the end
    const pattern = [2, 4, 4, 4, 4, 4, 2];
  
    // Initialize an array to hold the chunks
    const chunks = [];
  
    // Iterate over the pattern and slice the string into chunks
    for (let length of pattern) {
      // Take the first 'length' characters from the string
      const chunk = cleanString.slice(0, length);
      // Push the chunk to the 'chunks' array
      chunks.push(chunk);
      // Remove the chunk from the string
      cleanString = cleanString.slice(length);
    }
  
    // Join the chunks with dashes
    const formattedString = chunks.join('-');
  
    return formattedString;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});


app.post('/upload', upload.single('file'), (req, res) => {
    if (req.file) {
        const results = [];
        const headers = [];
        fs.createReadStream(req.file.path)
            .pipe(CSVParser())
            .on('headers', (headerList) => {
                headers.push(...headerList); // Save the headers
            })
            .on('data', (data) => results.push(data))
            .on('end', () => {
                // Send back just the headers to the client
                res.json({ headers, filename: req.file.filename });
            });
    } else {
        res.status(400).send('No file uploaded.');
    }
});

app.get('/process-csv', async (req, res) => {
    const { filename, column } = req.query;
    const filepath = path.join(__dirname, 'uploads', filename);
    const results = [];
    let headers;

    fs.createReadStream(filepath)
        .pipe(CSVParser())
        .on('headers', (headerList) => {
            headers = headerList; // Save the headers
        })
        .on('data', (data) => results.push(data))
        .on('end', async () => {
            // Ensure headers are parsed before proceeding
            if (!headers) {
                return res.status(500).send('Failed to parse CSV headers.');
            }
            let i = 0;
            let total_rows = results.length;
            // Process each row using the selected column for patient_license
            for (let row of results) {
                let patient_license = row[headers[column]];
                const url = "https://omma.us.thentiacloud.net/rest/public/patient-verify/search";


                const fetchData = async (license) => {
                    if (license === '') {
                        console.log('no license');
                        return {  licenseNumber: 'N/A',
                                  type: 'N/A',
                                  expirationDate: 'N/A',
                                  status: 'N/A',
                                  valid: false
                                };
                    }
                    license = format_patient_license(license)
                    try {
                        let response = await axios.get(url, { params: { licenseNumber: license } });
                        if (!response.data.result) {
                            throw new Error('No data returned on first attempt.');
                        }
                        console.log(response.data.result)
                        return response.data.result;
                    } catch (error) {
                        if (error.message === 'No data returned on first attempt.') {
                            // Modify the patient license by incrementing the 7th character
                            let parts = license.split('-');
                            let seventhChar = parts[1].charAt(3);
                            if (seventhChar.match(/[A-Z]/i)) { // Check if the character is a letter
                                // Increment the character
                                let incrementedChar = String.fromCharCode(seventhChar.charCodeAt(0) + 1);
                                parts[1] = parts[1].substr(0, 3) + incrementedChar;
                                license = parts.join('-');
                                console.log('trying again with ' + license)
                            }
                            // Attempt the second request with the modified license
                            try {
                                let secondResponse = await axios.get(url, { params: { licenseNumber: license } });
                                console.log(secondResponse.data.result)
                                return secondResponse.data.result;
                            } catch (secondError) {
                                console.error('Error with second axios request:', secondError);
                                return { error: "Failed to retrieve data on second attempt" };
                            }
                        } else {
                            console.error('Error with axios request:', error);
                            return { error: "Failed to retrieve data" };
                        }
                    }
                };

                let responseData = await fetchData(patient_license);
                // Append new data to the row as separate columns
                for (const [key, value] of Object.entries(responseData)) {
                    row[key] = value;
                }
                // Emit the progress update
                io.emit('progress', { current: i + 1, total: total_rows });
                i++;
            }



            // Convert the updated results back to CSV
            const csv = new ObjectsToCsv(results);
            // In the /process-csv route, ensure the output file has a .csv extension
            await csv.toDisk(`./uploads/processed_${filename}.csv`);
            res.download(`./uploads/processed_${filename}.csv`, `processed_${filename}.csv`);

        });
});



const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
