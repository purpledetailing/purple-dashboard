export default function VinSnapshot({ data }) {
    return (
        <div style={{ border: '1px solid purple', padding: '1rem', marginTop: '1rem' }}>
            <h3>Customer Service Record</h3>
            <p><strong>VIN:</strong> {data.vin}</p>
            <p><strong>Name:</strong> {data.name}</p>
            <p><strong>Address:</strong> {data.address}</p>
            <p><strong>Service Date:</strong> {data.service_date}</p>
            <p><strong>Service Type:</strong> {data.service_type}</p>
            <p><strong>Notes:</strong> {data.notes}</p>
        </div>
    );
}
